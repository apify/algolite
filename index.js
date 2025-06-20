const cors = require('cors')
const express = require('express')
const querystring = require('querystring')
const parseAlgoliaSQL = require('./src/parseAlgoliaSQL')
const { getIndex, existIndex, initExistingIndexes, getIndexName } = require('./src/indexes')

/**
 * Middleware for catching errors in Api routes
 */
const wrapAsyncMiddleware = asyncMiddleware => (req, res, next) => {
  return Promise.resolve(asyncMiddleware(req, res, next))
    .catch((error) => {
      console.error(error)
      return res.status(400).json({
        'message': 'Internal server error',
        'status': 500
      })
    })
}

const { v4 } = require('uuid')

const createServer = (options) => {
  const path = options.path || process.cwd()
  // Init indexes as background task
  initExistingIndexes(path).catch((err) => {
    console.log('Can not initialized indexes')
    console.error(err)
  })

  const app = express()

  app.use(express.json({ type: '*/*', limit: '50mb' }))
  app.use(cors({
    allowedHeaders: '*'
  }))

  // Health check endpoint
  app.get('/health', (_req, res) => {
    return res.status(200).json({
      status: 'ok'
    })
  })

  // See docs at https://www.algolia.com/doc/api-reference/api-methods/get-related-products/
  // This endpoint mimics the recommendation engine of Algolia.
  // It returns `maxRecommendations` objects from the index with top score (the queried item is ignored)
  // Each object in the database must contain the following attributes as they need to be mapped
  // to recommendation output
  // - obj.featuredScore: number (used as _score)
  // - obj._id (used as objectID)
  // - obj.name (used as name)
  app.post('/1/indexes/*/recommendations', wrapAsyncMiddleware(async (req, res) => {
    const { body } = req
    const { requests } = body

    const results = []

    if (requests && requests.length > 0) {
      for (const request of requests) {
        const { indexName, objectID, maxRecommendations } = request
        const db = await getIndex(indexName, path)
        const content = await db.SEARCH('*')
        const objects = (content || [])
          .map(object => ({
            _id: object.obj._id,
            name: object.obj.name,
            featuredScore: object.obj.featuredScore
          }))
          .filter(object => object._id !== objectID)
        objects.sort((a, b) => (a.featuredScore > b.featuredScore) ? -1 : 1) // descending order

        const hits = []
        const numRecommendations = maxRecommendations > 0 ? Math.min(maxRecommendations, objects.length) : objects.length
        for (let i = 0; i < numRecommendations; i++) {
          const object = objects[i]
          hits.push({
            // These 3 fields must be present on the object in the database
            _score: object.featuredScore,
            objectID: object._id,
            name: object.name
          })
        }

        results.push({ hits })
      }
    }

    return res.json({ results })
  }))

  app.post('/1/indexes/:indexName/query', wrapAsyncMiddleware(async (req, res) => {
    const { sortAttribute, sortDesc, indexName } = getIndexName(req)
    const { body } = req
    const { params: queryParams } = body
    const db = await getIndex(indexName, path)

    const { query, filters, facetFilters, page = 0, hitsPerPage = 20 } = queryParams ? querystring.parse(queryParams) : body

    const searchExp = []
    if (query !== undefined) {
      searchExp.push(!query ? '*' : query)
    }

    if (filters) {
      searchExp.push(parseAlgoliaSQL(db, filters))
    }

    if (facetFilters) {
      searchExp.push(parseAlgoliaSQL(db, facetFilters.map(f => Array.isArray(f) ? `(${f.join(' OR ')})` : f).join(' AND ')))
    }

    const result = await db.SEARCH(...searchExp)
    const nbHits = result.length
    const nbPages = Math.ceil(nbHits / hitsPerPage)

    let hits = result.map((item) => {
      const { obj } = item
      obj.objectID = obj._id
      delete obj._id
      return obj
    })
    if (sortAttribute) {
      hits = hits.sort((item1, item2) => {
        const item1Attr = item1[sortAttribute]
        const item2Attr = item2[sortAttribute]
        if (sortDesc) {
          return item2Attr >= item1Attr ? 1 : -1
        }
        return item2Attr <= item1Attr ? 1 : -1
      })
    }

    const from = page * hitsPerPage
    const end = (from + hitsPerPage) - 1

    return res.json({
      hits: hits.slice(from, end),
      params: queryParams || '',
      query: query || '',
      page,
      nbHits,
      nbPages,
      hitsPerPage
    })
  }))

  app.post('/1/indexes/:indexName', wrapAsyncMiddleware(async (req, res) => {
    const { indexName } = getIndexName(req)
    const { body } = req
    const _id = v4()

    const db = await getIndex(indexName, path)
    await db.PUT([{
      _id,
      ...body
    }])

    return res.status(201).json({
      createdAt: (new Date()).toISOString(),
      taskID: 'algolite-task-id',
      objectID: _id
    })
  }))

  app.post('/1/indexes/:indexName/batch', wrapAsyncMiddleware(async (req, res) => {
    const { indexName } = getIndexName(req)
    const { body } = req
    const puts = []
    const deletes = []

    for (const request of body.requests) {
      switch (request.action) {
        case 'updateObject':
          request.body._id = request.body.objectID
          delete request.body.objectID
          puts.push(request.body)
          break

        case 'deleteObject':
          deletes.push(request.body.objectID)
          break

        default:
          // not supported
          return res.status(400).end()
      }
    }

    const db = await getIndex(indexName, path)
    if (puts.length) {
      await db.PUT(puts)
    }
    if (deletes.length) {
      try {
        await db.DELETE(deletes)
      } catch (error) {
        if (error.notFound) {
          console.log('WARNING: Object not found!')
        } else {
          throw error
        }
      }
    }

    return res.status(201).json({
      taskID: 'algolite-task-id',
      objectIDs: body.requests.map(r => r.body.objectID)
    })
  }))

  app.put('/1/indexes/:indexName/:objectID', wrapAsyncMiddleware(async (req, res) => {
    const { indexName } = getIndexName(req)
    const { body } = req
    const { objectID } = req.params

    const db = await getIndex(indexName, path)
    try {
      await db.DELETE([objectID])
    } catch (error) {
      if (!error.notFound) {
        return res.status(500).end()
      }
    }

    await db.PUT([{
      _id: objectID,
      ...body
    }])

    return res.status(201).json({
      updatedAt: (new Date()).toISOString(),
      taskID: 'algolite-task-id',
      objectID
    })
  }))

  app.delete('/1/indexes/:indexName/:objectID', wrapAsyncMiddleware(async (req, res) => {
    const { indexName } = getIndexName(req)
    const { objectID } = req.params

    const db = await getIndex(indexName, path)
    try {
      await db.DELETE([objectID])
    } catch (error) {
      if (!error.notFound) {
        res.status(500).end()
      }
    }

    return res.status(200).json({
      deletedAt: (new Date()).toISOString(),
      taskID: 'algolite-task-id',
      objectID
    })
  }))

  app.post('/1/indexes/:indexName/deleteByQuery', wrapAsyncMiddleware(async (req, res) => {
    const { indexName } = getIndexName(req)
    const { body } = req
    const { params: queryParams } = body

    const { facetFilters } = querystring.parse(queryParams)

    const db = await getIndex(indexName, path)

    const searchExp = []
    if (facetFilters) {
      searchExp.push(parseAlgoliaSQL(db, facetFilters))
    }

    if (searchExp.length === 0) {
      return res.status(400).json({
        message: 'DeleteByQuery endpoint only supports tagFilters, facetFilters, numericFilters and geoQuery condition',
        status: 400
      })
    }

    const result = await db.SEARCH(...searchExp)
    const ids = result.map(obj => obj._id)
    await db.INDEX.DELETE(ids)

    return res.status(201).json({
      updatedAt: (new Date()).toISOString(),
      taskID: 'algolite-task-id'
    })
  }))

  app.post('/1/indexes/:indexName/clear', wrapAsyncMiddleware(async (req, res) => {
    const { indexName } = getIndexName(req)

    if (!existIndex(indexName, path)) {
      return res.status(400).end()
    }

    const db = await getIndex(indexName, path)
    const result = await db.INDEX.GET('')
    const ids = result.map(obj => obj._id)
    await db.INDEX.DELETE(ids)

    return res.status(200).json({
      taskID: 'algolite-task-id'
    })
  }))

  return app
}

module.exports = createServer

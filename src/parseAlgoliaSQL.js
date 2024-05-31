const parser = require('../algoliaDSLParser')

const buildSearchExpression = (rule, db) => {
  const { OR, AND, NOT } = db
  const { token, key, value, left, right } = rule
  if (token === 'MATCH') {
    return `${key}:${value.value}`
  } else if (token === 'OR') {
    const leftExpression = buildSearchExpression(left, db)
    const rightExpression = buildSearchExpression(right, db)
    return OR(leftExpression, rightExpression)
  } else if (token === 'AND') {
    const leftExpression = buildSearchExpression(left, db)
    const rightExpression = buildSearchExpression(right, db)
    return AND(leftExpression, rightExpression)
  } else if (token === 'NOT') {
    if (value.token === 'MATCH') {
      const expression = buildSearchExpression(value, db)
      return NOT('*', expression)
    }
    // Negation of combined filters is not supported by Algolia
    // https://www.algolia.com/doc/guides/managing-results/refine-results/filtering/in-depth/combining-boolean-operators/#negate-combined-filters
    throw new Error('NOT only supports MATCH')
  } else {
    // Only supports MATCH, OR, AND, NOT
    throw new Error('UNKNOWN TOKEN')
  }
}

module.exports = (db, sql) => {
  const ast = parser.parse(sql)

  return buildSearchExpression(ast, db)
}

# Algolite
An Implementation of [Algolia](https://www.algolia.com/) to emulate its REST API on your local machine or CI environments in order to speed up your development and testing cycles.

## Installation

```
npm install -g algolite
```

## Example

```
$ algolite --help

Usage: algolite [--port <port>] [--path <path>]

An Algolia REST API Implementation

Options:
--help                Display this help message and exit
--port <port>         The port to listen on (default: 9200)
--path <path>         The path to use for the LevelDB store (Your project folder)
```

Once running any algolia client can be used.

```javascript

const client = algoliasearch('app-id', 'api-key', {
  hosts: [{
    protocol: 'http',
    url: 'localhost:9200'
  }]
})

const index = client.initIndex('entries');

await index.addObject({
  title: 'Algolia 2019',
  contentType: 'events'
})

const result = await index.search('Algolia')
```

## Docker Image

```
docker run --rm -p 9200:9200 --name algolite marconi1992/algolite:0.1.1
```

## Our local run

If you want to run Algolite locally, you need to run:
```
docker build -t algolite-local-dev ./
docker run -v .:/algolite -p 9200:9200 -it algolite-local-dev /bin/bash
```

Then, inside the container, run:
```
npm i && node cli.js
```

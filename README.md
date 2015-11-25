[![Coverage Status](https://coveralls.io/repos/holidayextras/jsonapi-store-mongodb/badge.svg?branch=master&service=github)](https://coveralls.io/github/holidayextras/jsonapi-store-mongodb?branch=master)
[![Build Status](https://travis-ci.org/holidayextras/jsonapi-store-mongodb.svg?branch=master)](https://travis-ci.org/holidayextras/jsonapi-store-mongodb)
[![npm version](https://badge.fury.io/js/jsonapi-store-mongodb.svg)](http://badge.fury.io/js/jsonapi-store-mongodb)
[![Code Climate](https://codeclimate.com/github/holidayextras/jsonapi-store-mongodb/badges/gpa.svg)](https://codeclimate.com/github/holidayextras/jsonapi-store-mongodb)
[![Dependencies Status](https://david-dm.org/holidayextras/jsonapi-store-mongodb.svg)](https://david-dm.org/holidayextras/jsonapi-store-mongodb)


# jsonapi-store-mongodb

`jsonapi-server-mongodb` is a MongoDB backed data store for [`jsonapi-server`](https://github.com/holidayextras/jsonapi-server).

This project conforms to the specification laid out in the [jsonapi-server handler documentation](https://github.com/holidayextras/jsonapi-server/blob/master/documentation/handlers.md).

### Usage

```javascript
var MongoStore = require("jsonapi-store-mongodb");

jsonApi.define({
  resource: "comments",
  handlers: new MongoStore({
    url: "url: 'mongodb://localhost:27017/jsonapi",
  })
});
```

### Features

 * Search, Find, Create, Delete, Update
 * Efficient lookups via appropriate indexes

### To do

 * Filtering happens at the database layer

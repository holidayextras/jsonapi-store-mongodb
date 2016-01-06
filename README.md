[![Coverage Status](https://coveralls.io/repos/holidayextras/jsonapi-store-mongodb/badge.svg?branch=master&service=github)](https://coveralls.io/github/holidayextras/jsonapi-store-mongodb?branch=master)
[![Build Status](https://travis-ci.org/holidayextras/jsonapi-store-mongodb.svg?branch=master)](https://travis-ci.org/holidayextras/jsonapi-store-mongodb)
[![npm version](https://badge.fury.io/js/jsonapi-store-mongodb.svg)](http://badge.fury.io/js/jsonapi-store-mongodb)
[![Code Climate](https://codeclimate.com/github/holidayextras/jsonapi-store-mongodb/badges/gpa.svg)](https://codeclimate.com/github/holidayextras/jsonapi-store-mongodb)
[![Dependencies Status](https://david-dm.org/holidayextras/jsonapi-store-mongodb.svg)](https://david-dm.org/holidayextras/jsonapi-store-mongodb)


# jsonapi-store-mongodb

`jsonapi-store-mongodb` is a MongoDB backed data store for [`jsonapi-server`](https://github.com/holidayextras/jsonapi-server).

This project conforms to the specification laid out in the [jsonapi-server handler documentation](https://github.com/holidayextras/jsonapi-server/blob/master/documentation/handlers.md).

### Usage

```javascript
var MongoStore = require("jsonapi-store-mongodb");

jsonApi.define({
  resource: "comments",
  handlers: new MongoStore({
    url: "mongodb://localhost:27017/jsonapi",
  })
});
```

### Features

 * Search, Find, Create, Delete, Update
 * Efficient lookups via appropriate indexes
 * Database layer filtering, pagination and sorting

### Getting to Production

Getting this data store to production is really simple:

1. Bring up your MongoDB stack.
2. Create any indexes you may need (this is optional, this module will automatically ensure indexes exist on relationships, however you might want to add an index to an attribute you intend on querying aggressively).
3. Deploy your code.
4. Celebrate.

When making schema changes, deploy away and carry on. If the changes aren't backwards compatible, you may want to run a job to ensure all old (existing) records conform to the new schema. If they don't conform to the new schema, they will be dropped by jsonapi-server's validation layer.

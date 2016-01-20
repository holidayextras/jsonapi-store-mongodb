"use strict";
var _ = {
  omit: require("lodash.omit")
};
var async = require("async");
var debug = require("./debugging");
var mongodb = require("mongodb");


var MongoStore = module.exports = function MongoStore(config) {
  this._config = config;
};


/**
  Handlers readiness status. This should be set to `true` once all handlers are ready to process requests.
 */
MongoStore.prototype.ready = false;


MongoStore._mongoUuid = function(uuid) {
  return new mongodb.Binary(uuid, mongodb.Binary.SUBTYPE_UUID);
};


MongoStore._isRelationshipAttribute = function(attribute) {
  return attribute._settings && (attribute._settings.__one || attribute._settings.__many);
};


MongoStore._toMongoDocument = function(resource) {
  var document = _.omit(resource, function(value) { return value === undefined; });
  document._id = MongoStore._mongoUuid(document.id);
  return document;
};


MongoStore._getRelationshipAttributeNames = function(attributes) {
  var attributeNames = Object.getOwnPropertyNames(attributes);
  var relationshipAttributeNames = attributeNames.reduce(function(partialAttributeNames, name) {
    var attribute = attributes[name];
    if (MongoStore._isRelationshipAttribute(attribute)) {
      return partialAttributeNames.concat(name);
    }
    return partialAttributeNames;
  }, []);
  return relationshipAttributeNames;
};


MongoStore.prototype._getSearchCriteria = function(request) {
  var self = this;
  if (!request.params.filter) return { };

  var criteria = Object.keys(request.params.filter).map(function(attribute) {
    var attributeConfig = self.resourceConfig.attributes[attribute];
    // If the filter attribute doens't exist, skip it
    if (!attributeConfig) return null;

    var values = request.params.filter[attribute];
    // Relationships need to be queried via .id
    if (attributeConfig._settings) {
      attribute += ".id";
      // Filters on nested resources should be skipped
      if (values instanceof Object) return null;
    }

    // Coerce values to an array to simplify the logic
    if (!(values instanceof Array)) values = [ values ];
    values = values.map(function(value) {
      if (value[0] === "<") return { $lt: value.substring(1) };
      if (value[0] === ">") return { $gt: value.substring(1) };
      if (value[0] === "~") return new RegExp("^" + value.substring(1) + "$", "i");
      if (value[0] === ":") return new RegExp(value.substring(1));
      return value;
    }).map(function(value) {
      var tmp = { };
      tmp[attribute] = value;
      return tmp;
    });

    return { $or: values };
  }).filter(function(value) {
    return value !== null;
  });

  if (criteria.length === 0) {
    return { };
  }
  return { $and: criteria };
};


MongoStore._notFoundError = function(type, id) {
  return {
    status: "404",
    code: "ENOTFOUND",
    title: "Requested resource does not exist",
    detail: "There is no " + type + " with id " + id
  };
};


MongoStore.prototype._createIndexesForRelationships = function(collection, relationshipAttributeNames) {
  var index = relationshipAttributeNames.reduce(function(partialIndex, name) {
    partialIndex[name + ".id"] = 1;
    return partialIndex;
  }, {});
  collection.createIndex(index);
};


MongoStore.prototype._applySort = function(request, cursor) {
  if (!request.params.sort) return cursor;

  var attribute = request.params.sort;
  var order = 1;
  attribute = String(attribute);
  if (attribute[0] === "-") {
    order = -1;
    attribute = attribute.substring(1, attribute.length);
  }
  var sortParam = { };
  sortParam[attribute] = order;

  return cursor.sort(sortParam);
};


MongoStore.prototype._applyPagination = function(request, cursor) {
  if (!request.params.page) return cursor;

  return cursor.skip(request.params.page.offset).limit(request.params.page.limit);
};


/**
  Initialise gets invoked once for each resource that uses this handler.
 */
MongoStore.prototype.initialise = function(resourceConfig) {
  var self = this;
  if (!self._config.url) {
    return console.error("MongoDB url missing from configuration");
  }
  self.resourceConfig = resourceConfig;
  self.relationshipAttributeNames = MongoStore._getRelationshipAttributeNames(resourceConfig.attributes);
  mongodb.MongoClient.connect(self._config.url, {
    server: {
      reconnectTries: 999999999,
      reconnectInterval: 5000
    }
  }).then(function(db) {
    self._db = db;
    self._db.on("close", function(err) {
      console.error("mongodb connection closed:", err.message);
      self.ready = false;
      self._db.collection("Nope").findOne({ _id: 0 }, { _id: 0 }, function() {
        console.error("mongodb connection is back");
        self.ready = true;
      });
    });
  }).catch(function(err) {
    console.error("mongodb connection failed:", err.message);
    setTimeout(function() {
      self.initialise(resourceConfig);
    }, 5000);
  }).then(function() {
    var resourceName = resourceConfig.resource;
    var collection = self._db.collection(resourceName);
    self._createIndexesForRelationships(collection, self.relationshipAttributeNames);
    self.ready = true;
  });
};


/**
  Drops the database if it already exists and populates it with example documents.
 */
MongoStore.prototype.populate = function(callback) {
  var self = this;
  if (!self._db) return;

  self._db.dropDatabase(function(err) {
    if (err) return console.error("error dropping database", err.message);
    async.each(self.resourceConfig.examples, function(document, cb) {
      self.create({ params: {} }, document, cb);
    }, function(error) {
      if (error) console.error("error creating example document:", error);
      return callback();
    });
  });
};


/**
  Search for a list of resources, give a resource type.
 */
MongoStore.prototype.search = function(request, callback) {
  var self = this;
  var collection = self._db.collection(request.params.type);
  var criteria = self._getSearchCriteria(request);
  debug("search", JSON.stringify(criteria));

  async.parallel({
    resultSet: function(asyncCallback) {
      var cursor = collection.find(criteria, { _id: 0 });
      self._applySort(request, cursor);
      self._applyPagination(request, cursor);
      return cursor.toArray(asyncCallback);
    },
    totalRows: function(asyncCallback) {
      return collection.find(criteria, { _id: 0 }).count(asyncCallback);
    }
  }, function(err, results) {
    return callback(err, results.resultSet, results.totalRows);
  });
};


/**
  Find a specific resource, given a resource type and and id.
 */
MongoStore.prototype.find = function(request, callback) {
  var collection = this._db.collection(request.params.type);
  var documentId = MongoStore._mongoUuid(request.params.id);

  debug("findOne", JSON.stringify({ _id: documentId }));
  collection.findOne({ _id: documentId }, { _id: 0 }, function(err, result) {
    if (err || !result) {
      return callback(MongoStore._notFoundError(request.params.type, request.params.id));
    }
    return callback(null, result);
  });
};


/**
  Create (store) a new resource give a resource type and an object.
 */
MongoStore.prototype.create = function(request, newResource, callback) {
  var collection = this._db.collection(newResource.type);
  var document = MongoStore._toMongoDocument(newResource);
  debug("insert", JSON.stringify(document));
  collection.insertOne(document, function(err) {
    if (err) return callback(err);
    collection.findOne(document, { _id: 0 }, callback);
  });
};


/**
  Delete a resource, given a resource type and an id.
 */
MongoStore.prototype.delete = function(request, callback) {
  var collection = this._db.collection(request.params.type);
  var documentId = MongoStore._mongoUuid(request.params.id);
  collection.deleteOne({ _id: documentId }, function(err, result) {
    if (err) return callback(err);
    if (result.deletedCount === 0) {
      return callback(MongoStore._notFoundError(request.params.type, request.params.id));
    }
    return callback(err, result);
  });
};


/**
  Update a resource, given a resource type and id, along with a partialResource.
  partialResource contains a subset of changes that need to be merged over the original.
 */
MongoStore.prototype.update = function(request, partialResource, callback) {
  var collection = this._db.collection(request.params.type);
  var documentId = MongoStore._mongoUuid(request.params.id);
  var partialDocument = _.omit(partialResource, function(value) { return value === undefined; });
  debug("findOneAndUpdate", JSON.stringify(partialDocument));
  collection.findOneAndUpdate({
    _id: documentId
  }, {
    $set: partialDocument
  }, {
    returnOriginal: false,
    projection: { _id: 0 }
  }, function(err, result) {
    if (err) {
      debug("err", JSON.stringify(err));
      return callback(err);
    }

    if (!result || !result.value) {
      return callback(MongoStore._notFoundError(request.params.type, request.params.id));
    }

    debug("result", JSON.stringify(result));
    return callback(null, result.value);
  });
};

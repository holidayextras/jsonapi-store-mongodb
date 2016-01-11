"use strict";
var _ = {
  omit: require("lodash.omit")
};
var async = require("async");
var debug = require("./debugging");
var mongodb = require("mongodb");
var co = require("co");
var joi = require("joi");


var MongoStore = module.exports = function MongoStore(config) {
  this._config = config;
  this._initQueue = []
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
    var castValue=function(v, start){ return joi.attempt(v.substring(start||0), attributeConfig) }

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
      if (value[0] === "<") return value[1]==='=' ? { $lte: castValue(value,2) } : { $lt: castValue(value, 1) };
      if (value[0] === ">") return value[1]==='=' ? { $gte: castValue(value,2) } : { $gt: castValue(value, 1) };
      if (value[0] === "~") return new RegExp("^" + castValue( value, 1) + "$", "i");
      if (value[0] === ":") return new RegExp( castValue( value, 1) );
      return castValue(value);
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
  var initResource = function() {
    var resourceName = resourceConfig.resource;
    var collection = self._db.collection(resourceName);
    self._createIndexesForRelationships(collection, self.relationshipAttributeNames);
    self.ready = true;
    self.on_initialise&&self.on_initialise(resourceName, collection)
  }

  self.resourceConfig = resourceConfig;
  self.relationshipAttributeNames = MongoStore._getRelationshipAttributeNames(resourceConfig.attributes);

  if(!self._db){
    self._initQueue.push(initResource)
    if(self._initQueue.length==1)
    mongodb.MongoClient.connect(self._config.url).then(function(db) {
      self._db = db;
    }).catch(function(err) {
      return console.error("error connecting to MongoDB:", err.message);
    }).then(function(){
      while(self._initQueue.length) self._initQueue.shift()()
    });
  } else {
    initResource()
  }

};


/**
  Drops the database if it already exists and populates it with example documents.
 */
MongoStore.prototype.populate = function(callback) {
  var self = this;
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
  try{
    var criteria = self._getSearchCriteria(request);
  }catch(e){
    return callback({
        status: "500",
        code: "TypeError",
        title: "TypeError",
        detail: "输入错误"
      })
  }
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
MongoStore.prototype.create = co.wrap(function* (request, newResource, callback) {
  var self = this;
  if(self.before_create){
    try{ yield self.before_create(newResource.type, newResource) } catch(e){
      debug(e, 'create cancel')
      return callback({
          status: "500",
          code: "Internal Server Error",
          title: "Resource cannot be created",
          detail: e
        });
      }
  }
  var collection = this._db.collection(newResource.type);
  var document = MongoStore._toMongoDocument(newResource);
  debug("insert", JSON.stringify(document));
  collection.insertOne(document, function(err) {
    if (err) return callback(err);
    collection.findOne(document, { _id: 0 }, function(err, doc){
      if(self.after_create) return self.after_create.call(self, err, doc, function(){ callback(err, doc) });
      callback(err, doc)
    });
  });
});


/**
  Delete a resource, given a resource type and an id.
 */
MongoStore.prototype.delete = co.wrap(function* (request, callback) {
  var self = this;
  if(self.before_delete){
    try{ yield self.before_delete(request.params.type, request.params.id) } catch(e){
      debug(e, 'delete cancel')
      return callback({
          status: "500",
          code: "Internal Server Error",
          title: "Resource cannot be deleted",
          detail: e
        });
    }
  }
  var collection = this._db.collection(request.params.type);
  var documentId = MongoStore._mongoUuid(request.params.id);
  collection.deleteOne({ _id: documentId }, function(err, result) {
    if (err) return callback(err);
    if (result.deletedCount === 0) {
      return callback(MongoStore._notFoundError(request.params.type, request.params.id));
    }
    if(self.after_delete) self.after_delete.call(self, err, result, request.params.type, request.params.id, function(){callback(err, result)})
    return callback(err, result);
  });
});


/**
  Update a resource, given a resource type and id, along with a partialResource.
  partialResource contains a subset of changes that need to be merged over the original.
 */
MongoStore.prototype.update = co.wrap(function* (request, partialResource, callback) {
  // tutpoint: using co.wrap to instead of normal function, should callback with Promise!
  var self = this;
  if(self.before_update){
     try{ yield self.before_update(request.params.type, request.params.id, partialResource) } catch(e){
      debug(e, 'update cancel')
      return callback({
          status: "500",
          code: "Internal Server Error",
          title: "Resource cannot be updated",
          detail: e
        });
    }
  }
  var collection = self._db.collection(request.params.type);
  var documentId = MongoStore._mongoUuid(request.params.id);
  var partialDocument = _.omit(partialResource, function(value) { return value === undefined; });
  debug("findOneAndUpdate", JSON.stringify(partialDocument));
  collection.findOne({_id: documentId}, {fields: { _id: 0 }}, function(e,oldDoc){
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
      if(self.after_update) return self.after_update.call(self, null, oldDoc, result.value, function(){ return callback(null, result.value) } );
      return callback(null, result.value);
    });
  })
});

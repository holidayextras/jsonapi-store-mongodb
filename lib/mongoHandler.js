"use strict";
var _ = {
  clone: require("lodash.clone")
};
var async = require("async");
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


MongoStore.prototype._createIndexesForRelationships = function(collection, attributes) {
  Object.getOwnPropertyNames(attributes).forEach(function(name) {
    var attribute = attributes[name];
    if (!attribute._settings || (!attribute._settings.__one && !attribute._settings.__many)) return;
    var index = {};
    index[name + ".id"] = 1;
    collection.createIndex(index);
  });
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
  mongodb.MongoClient.connect(self._config.url).then(function(db) {
    self._db = db;
  }).catch(function(err) {
    return console.error("error connecting to MongoDB:", err.message);
  }).then(function() {
    var resourceName = resourceConfig.resource;
    console.log("initialising resource [" + resourceName + "]");
    var collection = self._db.collection(resourceName);
    self._createIndexesForRelationships(collection, resourceConfig.attributes);
    self.ready = true;
  });
};


/**
  Drops the database if it already exists and populates it with example documents.
 */
MongoStore.prototype.populate = function(callback) {
  var self = this;
  self._db.dropDatabase(function(err) {
    if (err) return console.error("error dropping database");
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
  var collection = this._db.collection(request.params.type);
  collection.find({}, { _id: 0 }).toArray(function(err, result) {
    if (err) return callback(err);
    // If a relationships param is passed in, filter against those relations
    var mustMatch = request.params.relationships;
    if (mustMatch) {
      mustMatch = request.params.relationships;
      var matches = result.filter(function(anyResource) {
        var match = true;
        Object.keys(mustMatch).forEach(function(i) {
          var fKeys = anyResource[i];
          if (!(fKeys instanceof Array)) fKeys = [ fKeys ];
          fKeys = fKeys.map(function(j) { return j.id; });
          if (fKeys.indexOf(mustMatch[i]) === -1) {
            match = false;
          }
        });
        return match;
      });
      return callback(null, matches);
    }
    // No specific search params are supported, so return ALL resources of the requested type
    return callback(null, result);
  });
};


/**
  Find a specific resource, given a resource type and and id.
 */
MongoStore.prototype.find = function(request, callback) {
  var collection = this._db.collection(request.params.type);
  var documentId = MongoStore._mongoUuid(request.params.id);
  collection.findOne({ _id: documentId }, { _id: 0 }, function(err, result) {
    if (err || !result) {
      return callback({
        status: "404",
        code: "ENOTFOUND",
        title: "Requested resource does not exist",
        detail: "There is no " + request.params.type + " with id " + request.params.id
      });
    }
    return callback(null, result);
  });
};


/**
  Create (store) a new resource give a resource type and an object.
 */
MongoStore.prototype.create = function(request, newResource, callback) {
  var collection = this._db.collection(newResource.type);
  var document = _.clone(newResource);
  document._id = MongoStore._mongoUuid(document.id);
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
      return callback({
        status: "404",
        code: "ENOTFOUND",
        title: "Requested resource does not exist",
        detail: "There is no " + request.params.type + " with id " + request.params.id
      });
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
  collection.findOneAndUpdate({ _id: documentId }, { $set: partialResource }, callback);
};

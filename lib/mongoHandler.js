"use strict";
var _ = {
  clone: require("lodash.clone")
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
  var document = _.clone(resource, true);
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


MongoStore._getSearchCriteria = function(relationships) {
  if (!relationships) return {};
  var relationshipNames = Object.getOwnPropertyNames(relationships);
  var criteria = relationshipNames.reduce(function(partialCriteria, relationshipName) {
    var relationshipId = relationships[relationshipName];
    partialCriteria[relationshipName + ".id"] = relationshipId;
    return partialCriteria;
  }, {});
  return criteria;
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
  mongodb.MongoClient.connect(self._config.url).then(function(db) {
    self._db = db;
  }).catch(function(err) {
    return console.error("error connecting to MongoDB:", err.message);
  }).then(function() {
    var resourceName = resourceConfig.resource;
    debug("initialising resource [" + resourceName + "]");
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
  debug("relationships> " + JSON.stringify(request.params.relationships, null, 2));
  var criteria = MongoStore._getSearchCriteria(request.params.relationships);
  debug("criteria> " + JSON.stringify(criteria, null, 2));
  collection.find(criteria, { _id: 0 }).toArray(callback);
};


/**
  Find a specific resource, given a resource type and and id.
 */
MongoStore.prototype.find = function(request, callback) {
  var collection = this._db.collection(request.params.type);
  var documentId = MongoStore._mongoUuid(request.params.id);
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
  collection.findOneAndUpdate({ _id: documentId }, { $set: partialResource }, callback);
};

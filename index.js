'use strict';
var mongoStore = module.exports = { };
mongoStore.handlers = { };

var _ = {
  clone: require('lodash.clone')
};
var mongodb = require('mongodb');


/**
  Handlers will only be ready to process requests after initialisation is complete.
 */
mongoStore.handlers.ready = false;

mongodb.resourcesToInitialise = [];

mongodb.MongoClient.connect('mongodb://localhost:27017/jsonapi').then(function(db) {
  mongoStore._db = db;
}).catch(function(err) {
  console.error('error connecting to MongoDB:', err.message);
}).then(function() {
  mongodb.resourcesToInitialise.forEach(mongoStore.handlers.initialise);
});


mongoStore._createIndexesForRelationships = function(collection, attributes) {
  Object.getOwnPropertyNames(attributes).forEach(function(name) {
    var attribute = attributes[name];
    if (!attribute._settings || (!attribute._settings.__one && !attribute._settings.__many)) return;
    var index = {};
    index[name + '.id'] = 1;
    collection.createIndex(index);
  });
  mongoStore.handlers.ready = true;
};


/**
  Initialise gets invoked once for each resource that uses this handler.
 */
mongoStore.handlers.initialise = function(resourceConfig) {
  if (!mongoStore._db) {
    return mongodb.resourcesToInitialise.push(resourceConfig);
  }
  var resourceName = resourceConfig.resource;
  console.log('initialising resource [' + resourceName + ']');
  var collection = mongoStore._db.collection(resourceName);
  mongoStore._createIndexesForRelationships(collection, resourceConfig.attributes);
  resourceConfig.examples.forEach(function(document) {
    mongoStore.handlers.create(null, document, function(err) {
      if (err) return console.error('error creating sample document:', err);
    });
  });
  mongoStore.handlers.ready = true;
};


/**
  Search for a list of resources, give a resource type.
 */
mongoStore.handlers.search = function(request, callback) {
  var collection = mongoStore._db.collection(request.params.type);
  collection.find({}, { _id: 0 }).toArray(function(err, result) {
    if (err) return callback(err);
    // If a relationships param is passed in, filter against those relations
    var mustMatch = request.params.relationships;
    if (mustMatch) {
      var mustMatch = request.params.relationships;
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
    };
    // No specific search params are supported, so return ALL resources of the requested type
    return callback(null, result);
  });
};


/**
  Find a specific resource, given a resource type and and id.
 */
mongoStore.handlers.find = function(request, callback) {
  var collection = mongoStore._db.collection(request.params.type);
  var documentId = new mongodb.Binary(request.params.id, mongodb.Binary.SUBTYPE_UUID);
  collection.findOne({ _id: documentId }, { _id: 0 }, function(err, result) {
    if (err || !result) {
      return callback({
        status: '404',
        code: 'ENOTFOUND',
        title: 'Requested resource does not exist',
        detail: 'There is no ' + request.params.type + ' with id ' + request.params.id
      });
    }
    return callback(null, result);
  });
};


/**
  Create (store) a new resource give a resource type and an object.
 */
mongoStore.handlers.create = function(request, newResource, callback) {
  var collection = mongoStore._db.collection(newResource.type);
  var document = _.clone(newResource);
  document._id = new mongodb.Binary(document.id, mongodb.Binary.SUBTYPE_UUID);
  collection.insertOne(document, function(err, result) {
    if (err) return callback(err);
    collection.findOne(document, { _id: 0 }, callback);
  });
};


/**
  Delete a resource, given a resource type and an id.
 */
mongoStore.handlers.delete = function(request, callback) {
  var collection = mongoStore._db.collection(request.params.type);
  var documentId = new mongodb.Binary(request.params.id, mongodb.Binary.SUBTYPE_UUID);
  collection.deleteOne({ _id: documentId }, callback);
};


/**
  Update a resource, given a resource type and id, along with a partialResource.
  partialResource contains a subset of changes that need to be merged over the original.
 */
mongoStore.handlers.update = function(request, partialResource, callback) {
  var collection = mongoStore._db.collection(request.params.type);
  var documentId = new mongodb.Binary(request.params.id, mongodb.Binary.SUBTYPE_UUID);
  collection.findOneAndUpdate({ _id: documentId }, { $set: partialResource }, callback);
};

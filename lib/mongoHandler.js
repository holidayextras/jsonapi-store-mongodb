/* eslint-disable */
'use strict';
var _ = require('lodash');
var async = require('async');
var mongodb = require('mongodb');
var Joi = require('joi');
var semver = require('semver');
var debug = require('./debugging');

var MIN_SERVER_VERSION = '1.10.0';

var MongoStore = (module.exports = function MongoStore(config) {
  MongoStore._checkMinServerVersion();
  this._config = config;
});

/**
  Handlers readiness status. This should be set to `true` once all handlers are ready to process requests.
 */
MongoStore.prototype.ready = false;

MongoStore._checkMinServerVersion = function() {
  var serverVersion = require('jsonapi-server')._version;
  if (!serverVersion) return;
  if (semver.lt(serverVersion, MIN_SERVER_VERSION)) {
    throw new Error(
      'This version of jsonapi-store-mongodb requires jsonapi-server>=' + MIN_SERVER_VERSION + '.'
    );
  }
};

MongoStore._mongoUuid = id => mongodb.ObjectID(id);


MongoStore._isRelationshipAttribute = function(attribute) {
  return attribute._settings && (attribute._settings.__one || attribute._settings.__many);
};

MongoStore._toMongoDocument = function(resource) {
  const document = _.omitBy(resource, value => value === undefined);
  document._id = this._mongoUuid();
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

MongoStore._filterElementToMongoExpr = function(filterElement) {
  var value = filterElement.value;
  if (Array.isArray(value)) return { $in: value };
  if (!filterElement.operator) return value;
  var mongoExpr = {
    '>': {
      $gt: value,
    },
    '<': {
      $lt: value,
    },
    '~': new RegExp('^' + value + '$', 'i'),
    ':': new RegExp(value),
  }[filterElement.operator];
  return mongoExpr;
};

/**
 * This takes the base implementation
 * from json-api-store-mongodb with some customization
 * Override search criteria by not using object for relationships
 * @param request
 * @returns {*}
 * @private
 */
MongoStore.prototype._getSearchCriteria = request => {
  let extraFilters = {};
  if (request.headers.extraFilters &&
    request.resourceConfig.filterMapper &&
    typeof request.resourceConfig.filterMapper === 'function') {
    extraFilters = request.resourceConfig.filterMapper(request.headers.extraFilters);
    Object.entries(extraFilters).forEach(([key, value]) => {
      extraFilters[key] = [ { operator: null, value } ]
    });
  }

  const filter = Object.assign(request.processedFilter || {}, extraFilters);

  const criteria = Object.keys(filter)
    .map(attribute => {
      let values = filter[attribute].map(MongoStore._filterElementToMongoExpr);
      values = values.reduce((mongoExpressions, mongoExpr) => {
        if (mongoExpr !== null) {
          const mongoExprForAttr = {};
          mongoExprForAttr[attribute] = mongoExpr;
          mongoExpressions.push(mongoExprForAttr);
        }
        return mongoExpressions;
      }, []);
      if (values.length === 0) {
        return null;
      }
      if (values.length === 1) {
        return values[0];
      }
      return {
        $or: values,
      };
    })
    .filter(value => value !== null);

  if (criteria.length === 1) {
    return criteria[0];
  }
  return {
    $and: criteria,
  };
};

MongoStore._notFoundError = function(type, id) {
  return {
    status: '404',
    code: 'ENOTFOUND',
    title: 'Requested resource does not exist',
    detail: 'There is no ' + type + ' with id ' + id,
  };
};

MongoStore._unknownError = function(err) {
  return {
    status: '500',
    code: 'EUNKNOWN',
    title: 'An unknown error has occured',
    detail: err,
  };
};

MongoStore.prototype._createIndexesForRelationships = function(
  collection,
  relationshipAttributeNames
) {
  if (!Array.isArray(relationshipAttributeNames) || !relationshipAttributeNames.length) return;

  relationshipAttributeNames.forEach(function(name) {
    var keys = {};
    keys[name + '.id'] = 1;
    collection.createIndex(keys);
  });
};

MongoStore.prototype._applySort = function(request, cursor) {
  if (!request.params.sort) return cursor;

  var attribute = request.params.sort;
  var order = 1;
  attribute = String(attribute);
  if (attribute[0] === '-') {
    order = -1;
    attribute = attribute.substring(1, attribute.length);
  }
  var sortParam = {};
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
  const self = this;
  if (!self._config.url) {
    console.error('MongoDB url missing from configuration');
    return;
  }
  self.resourceConfig = resourceConfig;
  self.relationshipAttributeNames = MongoStore._getRelationshipAttributeNames(
    resourceConfig.attributes
  );
  mongodb.MongoClient.connect(self._config.url, {
    reconnectTries: 999999999,
    reconnectInterval: 5000,
  })
    .then(db => {
      self._db = db;
      self._db.on('close', err => {
        console.error('mongodb connection closed:', err.message);
        self.ready = false;
        self._db.collection('Nope').findOne(
          {
            _id: 0,
          },
          {
            _id: 0,
          },
          () => {
            console.error('mongodb connection is back');
            self.ready = true;
          }
        );
      });
    })
    .catch(err => {
      console.error('mongodb connection failed:', err.message);
      setTimeout(() => {
        self.initialise(resourceConfig);
      }, 5000);
    })
    .then(() => {
      const resourceName = resourceConfig.collection || resourceConfig.resource;
      const collection = self._db.collection(resourceName);
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
    if (err) return console.error('error dropping database', err.message);
    async.each(
      self.resourceConfig.examples,
      function(document, cb) {
        var validationResult = Joi.validate(document, self.resourceConfig.attributes);
        if (validationResult.error) {
          return cb(validationResult.error);
        }
        self.create(
          {
            params: {},
          },
          validationResult.value,
          cb
        );
      },
      function(error) {
        if (error) console.error('error creating example document:', error);
        return callback();
      }
    );
  });
};

/**
  Search for a list of resources, give a resource type.
 */
MongoStore.prototype.search = function(request, callback) {
  const collection = this._db.collection(request.params.type);
  let criteria = this._getSearchCriteria(request);

  // Checks whether an attribute defines a relationship for a resource.
  // Apparently, this can be checked via the _settings property.
  // (got this from original _getSearchCriteria implementation)
  const isRelationship = attribute => {
    const attributeConfig = this.resourceConfig.attributes[attribute];
    return attributeConfig && attributeConfig._settings;
  };

  // If given a valid string id, will cast it to a mongo ObjectId.
  const castRelationshipId = id => {
    if (mongodb.ObjectId.isValid(id)) {
      return new mongodb.ObjectId(id);
    }
    return id;
  };

  // Parses the given attributes. These attributes may be in the form of an
  // array (from a $and, $or, ... criteria) or a simple object. Regardless the
  // form, it will cast all id's to ObjectIds if they represent a relationship.
  const parseRelationshipAttributes = attributes => {
    if (Array.isArray(attributes)) {
      return attributes.map(attribute => {
        const relationshipsToCast = Object.keys(attribute).filter(attr => isRelationship(attr));

        relationshipsToCast.forEach(relationship => {
          attribute[relationship] = castRelationshipId(attribute[relationship]);
        });

        return attribute;
      });
    }

    Object.keys(attributes).forEach(attributeKey => {
      if (isRelationship(attributeKey)) {
        attributes[attributeKey] = castRelationshipId(attributes[attributeKey]);
      }
    });

    return attributes;
  };

  ['$and', '$not', '$nor', '$or'].forEach(operator => {
    if (criteria[operator]) {
      criteria[operator] = parseRelationshipAttributes(criteria[operator]);
    } else {
      criteria = parseRelationshipAttributes(criteria);
    }
  });

  async.parallel(
    {
      resultSet: asyncCallback => {
        const cursor = collection.find(criteria);
        this._applySort(request, cursor);
        this._applyPagination(request, cursor);
        return cursor.toArray(asyncCallback);
      },
      totalRows: asyncCallback => collection.find(criteria).count(asyncCallback),
    },
    (err, results) => {
      if (err) {
        return callback(MongoStore._unknownError);
      }
      return callback(null, results.resultSet, results.totalRows);
    }
  );
};

/**
  Find a specific resource, given a resource type and and id.
 */
MongoStore.prototype.find = function(request, callback) {
  var collection = this._db.collection(request.params.type);
  var documentId = MongoStore._mongoUuid(request.params.id);

  debug(
    'findOne',
    {
      _id: documentId,
    }
  );
  collection.findOne(
    {
      _id: documentId,
      isSoftDeleted: false,
    },
    function(err, result) {
      if (err || !result) {
        return callback(MongoStore._notFoundError(request.params.type, request.params.id));
      }
      return callback(null, result);
    }
  );
};

/**
  Create (store) a new resource give a resource type and an object.
 */
MongoStore.prototype.create = function(request, newResource, callback) {
  var collection = this._db.collection(newResource.type);
  delete newResource.type;
  // SMELL: soft deleted must be false on creation.
  newResource.isSoftDeleted = false;
  var document = MongoStore._toMongoDocument(newResource);
  debug('insert', document);
  collection.insertOne(document, function(err) {
    if (err) return callback(MongoStore._unknownError(err));
    collection.findOne(document, function(findErr, result) {
      if (findErr) return callback(err);
      if (!result) return callback('Could not find document after insert');
      return callback(null, result);
    });
  });
};

/**
  Delete a resource, given a resource type and an id.
 */
MongoStore.prototype.delete = function(request, callback) {
  var collection = this._db.collection(request.params.type);
  var documentId = MongoStore._mongoUuid(request.params.id);
  collection.deleteOne(
    {
      _id: documentId,
    },
    function(err, result) {
      if (err) return callback(MongoStore._unknownError(err));
      if (result.deletedCount === 0) {
        return callback(MongoStore._notFoundError(request.params.type, request.params.id));
      }
      return callback(null, result);
    }
  );
};

/**
  Update a resource, given a resource type and id, along with a partialResource.
  partialResource contains a subset of changes that need to be merged over the original.
 */
MongoStore.prototype.update = function(request, partialResource, callback) {
  var collection = this._db.collection(request.params.type);
  var documentId = MongoStore._mongoUuid(request.params.id);
  var partialDocument = _.omitBy(partialResource, function(value) {
    return value === undefined;
  });
  debug('findOneAndUpdate', partialDocument);

  collection.findOneAndUpdate(
    {
      _id: documentId,
    },
    {
      $set: partialDocument,
    },
    {
      returnOriginal: false,
    },
    function(err, result) {
      if (err) {
        debug('err', err);
        return callback(MongoStore._unknownError(err));
      }

      if (!result || !result.value) {
        return callback(MongoStore._notFoundError(request.params.type, request.params.id));
      }

      debug('result', result);
      return callback(null, result.value);
    }
  );
};

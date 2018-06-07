const _ = require('lodash');
const async = require('async');
const mongodb = require('mongodb');
const Joi = require('joi');
const semver = require('semver');
const debug = require('./debugging');

const { getExtraFilters, parseCriteria, parseCriteriaToMongoExpr } = require('./customFiltering');

const MIN_SERVER_VERSION = '1.10.0';

const MongoStore = (module.exports = function MongoStore(config) {
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
  const filter = { ...(request.processedFilter || {}), ...getExtraFilters(request) };

  return parseCriteriaToMongoExpr(MongoStore, filter);
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
  let criteria = parseCriteria(this.resourceConfig, this._getSearchCriteria(request));

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
  const collection = this._db.collection(request.params.type);
  const documentId = MongoStore._mongoUuid(request.params.id);
  const filter = parseCriteriaToMongoExpr(MongoStore, getExtraFilters(request));
  const criteria = parseCriteria(this.resourceConfig,filter);

  debug(
    'findOne',
    {
      _id: documentId,
      ... criteria,
    }
  );
  collection.findOne(
    {
      _id: documentId,
      ... criteria,
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

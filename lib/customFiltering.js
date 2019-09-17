const mongodb = require('mongodb');

/**
 * Gets extra filters for this resource object, which aren't part of the user-defined
 * filters given with the filter query param. This function basically calls the (optional)
 * filterMapper function defined in the resourceConfig, and passes the optional
 * extraFilters object set in the request header.
 *
 * @param {Object} request - express.js request object
 */
const getExtraFilters = request => {
  let extraFilters = {};
  if (request.resourceConfig && request.resourceConfig.filterMapper &&
    typeof request.resourceConfig.filterMapper === 'function') {
    extraFilters = request.resourceConfig.filterMapper(request.headers.extraParams);
    Object.entries(extraFilters).forEach(([key, value]) => {
      extraFilters[key] = [{
        operator: null,
        value
      }]
    });
  }
  return extraFilters;
};

/**
 * Gets extra validation requirements for this resource object apart from the joi
 * validation present in the schema. The returned object is a map, where each key is
 * the attribute to compare the new resource to, and the value can be either a
 * primitive value, (triggering a direct comparison) an object, (triggering a deep
 * equal check) or an array (triggering a contains check)
 *
 * @param {Object} request - express.js request object
 */
const getExtraValidation = request => {
  if (request.resourceConfig && request.resourceConfig.validationMapper &&
    typeof request.resourceConfig.validationMapper === 'function') {
    return request.resourceConfig.validationMapper(request.headers.extraParams);
  }
  return {};
};

/**
 * Checks whether an attribute defines a relationship for a resource.
 * Apparently, this can be checked via the _settings property.
 * (got this from original _getSearchCriteria implementation)
 *
 * @param {String} attribute - Name of an attribute of a filter 
 */
const isRelationship = (resourceConfig, attribute) => {
  const attributeConfig = resourceConfig.attributes[attribute];

  let potentialPluralAttrConfig = false;
  if (attribute.endsWith('s')) {
    potentialPluralAttrConfig = resourceConfig.attributes[attribute.slice(0, -1)];
  }
  return (attributeConfig && attributeConfig._settings) ||
    (potentialPluralAttrConfig && potentialPluralAttrConfig._settings);
};

/**
 * If given a valid string id, will cast it to a mongo ObjectId.
 *
 * @param {String} id - Id of a relationship
 */
const castRelationshipId = id => {
  if (mongodb.ObjectId.isValid(id)) {
    return new mongodb.ObjectId(id);
  }
  return id;
};

/**
 * Recursive function which runs through a resource related object. 
 * This resource object can contain strings, arrays or objects, potentially 
 * with mongo expressions sprinkled throughout. After running through the 
 * recursion, the returned object will have all it's valid id's which map 
 * to a relationship on the resource converted to a valid mongodb ObjectId.
 *
 * @param {String} key - The key of the attribute
 * @param {*} val - The value of the attribute
 * @param {Object} resourceConfig - Configuration details of the resource,
 *                                  defined in it's index.js
 */
const parseRelationshipAttributes = (key, val, resourceConfig) => {
  if (Array.isArray(val)) {
    return val.map(subVal => parseRelationshipAttributes(key, subVal, resourceConfig));
  }
  if (val !== null && typeof val === 'object') {
    if (val['_bsontype']) {
      // Allready an object id if it has a _bsontype
      return val;
    }

    let parsedVal = val;
    Object.keys(val).forEach(valKey => {
      let keyToCheck = valKey;
      if (valKey.substring(0, 1) === '$') {
        // mongo operator, ignore it as a level for relationship key check in the recursion
        keyToCheck = key;
      }
      parsedVal[valKey] = parseRelationshipAttributes(keyToCheck, val[valKey], resourceConfig);
    });
    return parsedVal;
  }

  // value is not an object or array. Actual relationship parsing possible.
  if (isRelationship(resourceConfig, key)) {
    return castRelationshipId(val);
  }

  return val;
};

/**
 * Parses a resource object so all relationship ids are valid mongodb ObjectIds. 
 *
 * @param {Object} resourceConfig - Configuration details of the resource,
 *                                  defined in it's index.js
 * @param {Object} given - An Object representing either a mongo expression or a
 *                         new resource
 */
const parseObjectRelationships = (resourceConfig, given) => {
  const result = {};
  Object.keys(given).forEach(key => {
    result[key] = parseRelationshipAttributes(key, given[key], resourceConfig);
  });
  return result;
};

/**
 * Validates a resource object against potential custom validation rules as
 * defined on the resource. 
 *
 * @param {Object} request - express.js request object
 * @param {Object} newResource - An Object representing either a new (partial) resource
 */
const validateResource = (request, newResource) =>  {
  const validation = getExtraValidation(request);
  const validate = (validator, toValidate) => {
    if (Array.isArray(validator)) {
      return validator.find((validatorElement) => {
        return JSON.stringify(validatorElement) === JSON.stringify(toValidate);
      });
    } else if (typeof validator === 'object') {
      // Don't really need a true deepEqual check yet, JSON.stringify is okay
      return JSON.stringify(validator) === JSON.stringify(toValidate);
    }
    return validator === toValidate;
  }

  Object.keys(validation).forEach(key => {
    if (newResource[key]) {
      // Only validate if the object actually has the key. If they are not present,
      // yet required, joi validation will (should) take care of that.
      const validator = validation[key];
      const isValid = validate(validation[key], newResource[key]);

      if (!isValid) {
        throw new Error(`Invalid value passed for ${key}`);
      }
    }
  });

  return newResource;
};

/**
 * Exposed the parsing to a mongo expression part of the _getSearchCriteria
 * function so it can be easily reused in the find function.
 *
 * @param {Object} filter 
 */
const parseCriteriaToMongoExpr = (MongoStore, filter) => {
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

  if (criteria.length === 0) {
    return {};
  }
  if (criteria.length === 1) {
    return criteria[0];
  }
  return {
    $and: criteria,
  };
};

module.exports = {
  validateResource,
  getExtraFilters,
  parseObjectRelationships,
  parseCriteriaToMongoExpr,
};

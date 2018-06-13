const assert = require('assert')
const mongodb = require('mongodb');
const { validateResource, parseObjectRelationships } = require('../lib/customFiltering');

describe('Testing customFiltering', () => {
  const createRequest = (extraParams, validationMapper) => {
    return {
      headers: {
        extraParams,
      },
      resourceConfig: {
        validationMapper,
      }
    }
  }

  const basicResource = {
    id: '7a0084691b541c0039ca60ca',
    property: 'myProperty',
    owner: '5989670509ac2575ce44f2f7'
  }

  const clientScope = [
    '5989670509ac2575ce44f2f7',
    '5989670509ac2575ce44f2f6',
  ];

  describe('Function validateResource', () => {
    it('Should let through basic resource without validation', () => {
      const requestWithoutValidation = createRequest();
      const validatedResource = validateResource(requestWithoutValidation, basicResource);

      assert.equal(validatedResource, basicResource);
    })

    it('Should validate on simple property', () => {
      const correctResource = basicResource;
      const incorrectResource = {
        id: '6a0084ed1b541c0039ca60d2',
        property: 'inCorrect',
      };

      const basicValidationRequest = createRequest(
        {
          simplePropertyValidation: 'myProperty'
        },
        (extraParams) => ({ property: extraParams['simplePropertyValidation'] }),
      );
      
      assert.equal(validateResource(basicValidationRequest, correctResource), correctResource);
      assert.throws(() => { validateResource(basicValidationRequest, incorrectResource) });
    });

    it ('Should validate on array property', () => {
      const correctResource = basicResource;
      const secondCorrectResource = basicResource;
      secondCorrectResource.owner = '5989670509ac2575ce44f2f6';
      const incorrectResource = {
        id: '6a0084ed1b541c0039ca60d2',
        property: 'myProperty',
        owner: '5989670509ac2575ce44f2d8' // Not in client scope list
      }

      const basicValidationRequest = createRequest(
        {
          clientScope,
        },
        (extraParams) => ({ owner: extraParams['clientScope'] }),
      );

      assert.equal(validateResource(basicValidationRequest, correctResource), correctResource);
      assert.equal(validateResource(basicValidationRequest, secondCorrectResource), correctResource);
      assert.throws(() => { validateResource(basicValidationRequest, incorrectResource) });
    })
  });

  describe('Function parseObjectRelationships', () => {
    const resourceConfig = {
      attributes: {
        owner: {
          _settings: true, // this makes it a relationship
        },
        report: {
          _settings: true,
        },
        company: {
          _settings: true,
        },
      },
    };

    it ('Should not change resource without relationships', () => {
      const relationshipLessResource = {
        id: '7a0084691b541c0039ca60ca',
        property: 'myProperty',
      };

      assert.deepEqual(parseObjectRelationships(resourceConfig, relationshipLessResource), relationshipLessResource);
    });

    it ('Should parse a relationship attribute from a resource to a mongoId', () => {
      const expectedResult = basicResource;
      basicResource.owner = new mongodb.ObjectId(basicResource.owner);

      assert.deepEqual(parseObjectRelationships(resourceConfig, basicResource), expectedResult);
    });

    it ('Should correctly parse a mongo expression', () => {
      const mongoExpr = {
        owner: {
          $and: clientScope,
        }
      }
      const validMongoExpr = mongoExpr;
      validMongoExpr.owner.$and = validMongoExpr.owner.$and.map(key => new mongodb.ObjectId(key));

      assert.deepEqual(parseObjectRelationships(resourceConfig, mongoExpr), validMongoExpr);
    });

    it ('Should correctly parse a complex mongo expression', () => {
      const mongoExpr = {
        owner: {
          $and: [
            '5989670509ac2575ce44f2f7',
            '5989670509ac2575ce44f2f6'
          ]
        },
        report: {
          $or: [
            '7a0084691b541c0039ca60ca',
            '2a0084691b541c0039ca60ca'
          ]
        },
        company: '9a0084691b541c0039ca60ca',
        id: '6a0084ed1b541c0039ca60d2',
        property: 'myProperty'
      }

      const validMongoExpr = {
        owner: {
          $and: [
            new mongodb.ObjectId('5989670509ac2575ce44f2f7'),
            new mongodb.ObjectId('5989670509ac2575ce44f2f6'),
          ]
        },
        report: {
          $or: [
            new mongodb.ObjectId('7a0084691b541c0039ca60ca'),
            new mongodb.ObjectId('2a0084691b541c0039ca60ca'),
          ]
        },
        company: new mongodb.ObjectId('9a0084691b541c0039ca60ca'),
        id: '6a0084ed1b541c0039ca60d2',
        property: 'myProperty'
      }

      assert.deepEqual(parseObjectRelationships(resourceConfig, mongoExpr), validMongoExpr);
    });
  });
});

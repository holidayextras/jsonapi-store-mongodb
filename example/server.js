"use strict";
var async = require("async");
var JsonapiStoreMongo = require("..");
var instances = [ ];

// Replace the MemoryStore default handler with our own version
require("jsonapi-server/lib/MemoryHandler");
module.children[2].exports = function() {
  var dbStore = new JsonapiStoreMongo({
    url: "mongodb://localhost:27017/jsonapi-test"
  });
  // Keep the handler around for after the test rig is live
  instances.push(dbStore);
  return dbStore;
};

var jsonApiTestServer = require("jsonapi-server/example/server.js");
jsonApiTestServer.start();

// Before starting the test suite, load all example resouces, aka
// the test fixtures, into the databases
setTimeout(function() {
  async.map(instances, function(dbStore, callback) {
    dbStore.populate(callback);
  });
}, 10000);

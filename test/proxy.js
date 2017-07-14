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

// Load the jsonapi-server test suite
var fs = require("fs");
var path = require("path");
var base = path.join(__dirname, "../node_modules/jsonapi-server/test");

fs.readdirSync(base).forEach(function(filename) {
  try {
    var filePath = path.join(base, filename)

    // If the current file we're attempting to read is a directory, don't require it.
    if (fs.lstatSync(filePath).isDirectory()) {

    } else {
      require(filePath)
    }
  } catch(e) { }
});

// Before starting the test suite, load all example resouces, aka
// the test fixtures, into the databases
before(function(done) {
  setTimeout(function() {
    async.map(instances, function(dbStore, callback) {
      dbStore.populate(callback);
    }, done);
  }, 10000);
});

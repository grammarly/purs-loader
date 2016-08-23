'use strict';

var path = require('path');

var Promise = require('bluebird');

var fs = Promise.promisifyAll(require('fs'));

var globby = require('globby');

var debug = require('debug')('purs-loader');

var srcModuleRegex = /(?:^|\n)module\s+([\w\.]+)/i;

function match(str) {
  var matches = str.match(srcModuleRegex);
  return matches && matches[1];
}
module.exports.match = match;

function makeMapEntry(filePurs) {
  var dirname = path.dirname(filePurs);

  var basename = path.basename(filePurs, '.purs');

  var fileJs = path.join(dirname, basename + '.js');

  var result = Promise.props({
    filePurs: fs.readFileAsync(filePurs, 'utf8'),
    fileJs: fs.readFileAsync(fileJs, 'utf8').catch(function () {
      return undefined;
    })
  }).then(function (fileMap) {
    var sourcePurs = fileMap.filePurs;

    var sourceJs = fileMap.fileJs;

    var moduleName = match(sourcePurs);

    var map = {};

    map[moduleName] = map[moduleName] || {};

    map[moduleName].src = path.resolve(filePurs);

    if (sourceJs) {
      map[moduleName].ffi = path.resolve(fileJs);
    }

    return map;
  });

  return result;
}
module.exports.makeMapEntry = makeMapEntry;

function makeMap(src) {
  debug('loading PureScript source and FFI files from %o', src);

  var globs = [].concat(src);

  return globby(globs).then(function (paths) {
    return Promise.all(paths.map(makeMapEntry)).then(function (result) {
      return result.reduce(Object.assign, {});
    });
  });
}
module.exports.makeMap = makeMap;
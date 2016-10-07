'use strict';

var path = require('path');

var Promise = require('bluebird');

var fs = Promise.promisifyAll(require('fs'));

var spawn = require('cross-spawn');

var debug = require('debug')('purs-loader');

var dargs = require('./dargs');

function compile(psModule, _compilation) {
  var options = psModule.options;
  var cache = psModule.cache;
  var stderr = [];

  if (cache.compilationStarted) return Promise.resolve(psModule);

  cache.compilationStarted = true;

  var args = dargs(Object.assign({
    _: options.src,
    output: options.output
  }, options.pscArgs));

  debug('spawning compiler %s %o', options.psc, args);

  return new Promise(function (resolve, reject) {
    console.log('\nCompiling PureScript...');

    var compilation = spawn(options.psc, args);

    compilation.stdout.on('data', function (data) {
      return stderr.push(data.toString());
    });
    compilation.stderr.on('data', function (data) {
      return stderr.push(data.toString());
    });

    compilation.on('close', function (code) {
      console.log('Finished compiling PureScript.');
      cache.compilationFinished = true;
      if (code !== 0) {
        cache.errors = stderr.join('');
        reject(true);
      } else {
        cache.warnings = stderr.join('');
        resolve(psModule);
      }
    });
  }).then(function (compilerOutput) {
    if (options.bundle) {
      return waitForModules(_compilation).then(function () {
        return bundle(options, cache);
      }).then(function () {
        return psModule;
      });
    }
    return psModule;
  });
}
module.exports.compile = compile;

function waitForModules(_compilation) {
  function isReady() {
    var modules = _compilation.modules;
    for (var i = 0; i < modules.length; i++) {
      var _module = modules[i];
      if (_module.building && /\.purs$/.test(_module.rawRequest)) {
        return false;
      }
    }
    return true;
  }

  function check(resolve, reject) {
    if (isReady()) {
      resolve();
    } else {
      setTimeout(function () {
        check(resolve, reject);
      }, 200);
    }
  }

  return new Promise(check);
}

function bundle(options, cache) {
  // TODO looks to be incorrect, must not go further if bundling is started
  if (cache.bundle) return Promise.resolve(cache.bundle);

  cache.isBundlingStarted = true;

  var stdout = [];
  var stderr = cache.bundle = [];

  var args = dargs(Object.assign({
    _: [path.join(options.output, '*', '*.js')],
    output: options.bundleOutput,
    namespace: options.bundleNamespace
  }, options.pscBundleArgs));

  cache.bundleModules.forEach(function (name) {
    return args.push('--module', name);
  });

  debug('spawning bundler %s %o', options.pscBundle, args.join(' '));

  return new Promise(function (resolve, reject) {
    console.log('Bundling PureScript...');

    var compilation = spawn(options.pscBundle, args);

    compilation.stdout.on('data', function (data) {
      return stdout.push(data.toString());
    });
    compilation.stderr.on('data', function (data) {
      return stderr.push(data.toString());
    });
    compilation.on('close', function (code) {
      if (code !== 0) {
        cache.errors = (cache.errors || '') + stderr.join('');
        return reject(true);
      }
      cache.bundle = stderr;
      resolve(fs.appendFileAsync(options.bundleOutput, 'module.exports = ' + options.bundleNamespace));
    });
  });
}
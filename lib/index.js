'use strict';

var _typeof = typeof Symbol === "function" && typeof Symbol.iterator === "symbol" ? function (obj) { return typeof obj; } : function (obj) { return obj && typeof Symbol === "function" && obj.constructor === Symbol ? "symbol" : typeof obj; };

var debug = require('debug')('purs-loader');
var loaderUtils = require('loader-utils');
var Promise = require('bluebird');
var fs = Promise.promisifyAll(require('fs'));
var path = require('path');
var jsStringEscape = require('js-string-escape');
var PsModuleMap = require('./PsModuleMap');
var Psc = require('./Psc');
var PscIde = require('./PscIde');
var dargs = require('./dargs');

var requireRegex = /require\(['"]\.\.\/([\w\.]+)['"]\)/g;

module.exports = function purescriptLoader(source, map) {
  var callback = this.async();
  var config = this.options;
  var query = loaderUtils.parseQuery(this.query);
  var webpackOptions = this.options.purescriptLoader || {};

  var options = Object.assign({
    context: config.context,
    psc: 'psc',
    pscArgs: {},
    pscBundle: 'psc-bundle',
    pscBundleArgs: {},
    pscIde: false,
    pscIdeColors: webpackOptions.psc === 'psa' || query.psc === 'psa',
    pscIdeArgs: {},
    bundleOutput: 'output/bundle.js',
    bundleNamespace: 'PS',
    bundle: false,
    warnings: true,
    output: 'output',
    src: [path.join('src', '**', '*.purs'), path.join('bower_components', 'purescript-*', 'src', '**', '*.purs')]
  }, webpackOptions, query);

  this.cacheable && this.cacheable();

  var cache = config.purescriptLoaderCache = config.purescriptLoaderCache || {
    rebuild: false,
    deferred: [],
    bundleModules: []
  };

  if (!config.purescriptLoaderInstalled) {
    config.purescriptLoaderInstalled = true;

    // invalidate loader cache when bundle is marked as invalid (in watch mode)
    this._compiler.plugin('invalid', function () {
      debug('invalidating loader cache');

      cache = config.purescriptLoaderCache = {
        rebuild: options.pscIde,
        deferred: [],
        bundleModules: [],
        ideServer: cache.ideServer,
        psModuleMap: cache.psModuleMap
      };
    });

    // add psc warnings to webpack compilation warnings
    this._compiler.plugin('after-compile', function (compilation, callback) {
      if (options.warnings && cache.warnings) {
        compilation.warnings.unshift('PureScript compilation:\n' + cache.warnings);
        cache.warnings = null;
      }

      if (cache.errors) {
        compilation.errors.unshift('PureScript compilation:\n' + cache.errors);
        cache.errors = null;
      }

      callback();
    });
  }

  var psModuleName = PsModuleMap.match(source);
  var psModule = {
    name: psModuleName,
    load: function load(js) {
      return callback(null, js);
    },
    reject: function reject(error) {
      return callback(error);
    },
    srcPath: this.resourcePath,
    srcDir: path.dirname(this.resourcePath),
    jsPath: path.resolve(path.join(options.output, psModuleName, 'index.js')),
    options: options,
    cache: cache
  };

  debug('loader called', psModule.name);

  if (options.bundle) {
    if (cache.isBundlingStarted) {
      callback(new Error('PureScript bundling is already started, cannot add module ' + psModule.name));
      return;
    }
    cache.bundleModules.push(psModule.name);
  }

  if (cache.rebuild) {
    return PscIde.connect(psModule).then(PscIde.rebuild).then(toJavaScript).then(psModule.load).catch(psModule.reject);
  }

  if (cache.compilationFinished) {
    return toJavaScript(psModule).then(psModule.load).catch(psModule.reject);
  }

  // We need to wait for compilation to finish before the loaders run so that
  // references to compiled output are valid.
  cache.deferred.push(psModule);

  if (!cache.compilationStarted) {
    return Psc.compile(psModule, this._compilation).then(function () {
      return PsModuleMap.makeMap(options.src).then(function (map) {
        debug('rebuilt module map');
        cache.psModuleMap = map;
      });
    }).then(function () {
      return Promise.map(cache.deferred, function (psModule) {
        if (_typeof(cache.ideServer) === 'object') cache.ideServer.kill();
        return toJavaScript(psModule).then(psModule.load);
      });
    }).catch(function (error) {
      cache.deferred[0].reject(error);
      cache.deferred.slice(1).forEach(function (psModule) {
        return psModule.reject(true);
      });
    });
  }
};

function updatePsModuleMap(psModule) {
  var options = psModule.options;
  var cache = psModule.cache;
  var filePurs = psModule.srcPath;
  if (!cache.psModuleMap) {
    debug('module mapping does not exist');
    return PsModuleMap.makeMap(options.src).then(function (map) {
      cache.psModuleMap = map;
      return cache.psModuleMap;
    });
  } else {
    return PsModuleMap.makeMapEntry(filePurs).then(function (result) {
      var map = Object.assign(cache.psModuleMap, result);
      cache.psModuleMap = map;
      return cache.psModuleMap;
    });
  }
}

// The actual loader is executed *after* purescript compilation.
function toJavaScript(psModule) {
  var options = psModule.options;
  var cache = psModule.cache;
  var bundlePath = path.resolve(options.bundleOutput);
  var jsPath = cache.bundle ? bundlePath : psModule.jsPath;

  debug('loading JavaScript for', psModule.name);

  return Promise.props({
    js: fs.readFileAsync(jsPath, 'utf8'),
    psModuleMap: updatePsModuleMap(psModule)
  }).then(function (result) {
    var js = '';

    if (options.bundle) {
      // if bundling, return a reference to the bundle
      js = 'module.exports = require("' + jsStringEscape(path.relative(psModule.srcDir, options.bundleOutput)) + '")["' + psModule.name + '"]';
    } else {
      // replace require paths to output files generated by psc with paths
      // to purescript sources, which are then also run through this loader.
      js = result.js.replace(requireRegex, function (m, p1) {
        return 'require("' + jsStringEscape(result.psModuleMap[p1].src) + '")';
      }).replace(/require\(['"]\.\/foreign['"]\)/g, function (m, p1) {
        return 'require("' + jsStringEscape(result.psModuleMap[psModule.name].ffi) + '")';
      });
    }

    return js;
  });
}
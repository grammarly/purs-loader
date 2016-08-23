'use strict';

var path = require('path');

var Promise = require('bluebird');

var fs = Promise.promisifyAll(require('fs'));

var retryPromise = require('promise-retry');

var spawn = require('cross-spawn');

var colors = require('chalk');

var debug = require('debug')('purs-loader');

var dargs = require('./dargs');

var Psc = require('./Psc');

var PsModuleMap = require('./PsModuleMap');

function connect(psModule) {
  var options = psModule.options;
  var cache = psModule.cache;

  if (cache.ideServer) return Promise.resolve(psModule);

  cache.ideServer = true;

  var connect_ = function connect_() {
    return new Promise(function (resolve, reject) {
      var args = dargs(options.pscIdeArgs);

      debug('attempting to connect to psc-ide-server', args);

      var ideClient = spawn('psc-ide-client', args);

      ideClient.stderr.on('data', function (data) {
        debug(data.toString());
        cache.ideServer = false;
        reject(true);
      });
      ideClient.stdout.once('data', function (data) {
        debug(data.toString());
        if (data.toString()[0] === '{') {
          var res = JSON.parse(data.toString());
          if (res.resultType === 'success') {
            cache.ideServer = ideServer;
            resolve(psModule);
          } else {
            cache.ideServer = ideServer;
            reject(true);
          }
        } else {
          cache.ideServer = false;
          reject(true);
        }
      });
      ideClient.stdin.resume();
      ideClient.stdin.write(JSON.stringify({ command: 'load' }));
      ideClient.stdin.write('\n');
    });
  };

  var args = dargs(Object.assign({
    outputDirectory: options.output
  }, options.pscIdeArgs));

  debug('attempting to start psc-ide-server', args);

  var ideServer = cache.ideServer = spawn('psc-ide-server', []);
  ideServer.stderr.on('data', function (data) {
    debug(data.toString());
  });

  return retryPromise(function (retry, number) {
    return connect_().catch(function (error) {
      if (!cache.ideServer && number === 9) {
        debug(error);

        console.log('failed to connect to or start psc-ide-server, ' + 'full compilation will occur on rebuild');

        return Promise.resolve(psModule);
      }

      return retry(error);
    });
  }, {
    retries: 9,
    factor: 1,
    minTimeout: 333,
    maxTimeout: 333
  });
}
module.exports.connect = connect;

function rebuild(psModule) {
  var options = psModule.options;
  var cache = psModule.cache;

  debug('attempting rebuild with psc-ide-client %s', psModule.srcPath);

  var request = function request(body) {
    return new Promise(function (resolve, reject) {
      var args = dargs(options.pscIdeArgs);
      var ideClient = spawn('psc-ide-client', args);

      var stdout = '';
      var stderr = '';

      ideClient.stdout.on('data', function (data) {
        stdout = stdout + data.toString();
      });

      ideClient.stderr.on('data', function (data) {
        stderr = stderr + data.toString();
      });

      ideClient.on('close', function (code) {
        if (code !== 0) {
          var error = stderr === '' ? 'Failed to spawn psc-ide-client' : stderr;
          return reject(new Error(error));
        }

        var res = null;

        try {
          res = JSON.parse(stdout.toString());
          debug(res);
        } catch (err) {
          return reject(err);
        }

        if (res && !Array.isArray(res.result)) {
          return res.resultType === 'success' ? resolve(psModule) : reject('psc-ide rebuild failed');
        }

        Promise.map(res.result, function (item, i) {
          debug(item);
          return formatIdeResult(item, options, i, res.result.length);
        }).then(function (compileMessages) {
          if (res.resultType === 'error') {
            if (res.result.some(function (item) {
              return item.errorCode === 'UnknownModule' || item.errorCode === 'UnknownName';
            })) {
              debug('unknown module, attempting full recompile');
              return Psc.compile(psModule).then(function () {
                return PsModuleMap.makeMap(options.src).then(function (map) {
                  debug('rebuilt module map');
                  cache.psModuleMap = map;
                });
              }).then(function () {
                return request({ command: 'load' });
              }).then(resolve).catch(function () {
                return reject('psc-ide rebuild failed');
              });
            }
            cache.errors = compileMessages.join('\n');
            reject('psc-ide rebuild failed');
          } else {
            cache.warnings = compileMessages.join('\n');
            resolve(psModule);
          }
        });
      });

      ideClient.stdin.write(JSON.stringify(body));
      ideClient.stdin.write('\n');
    });
  };

  return request({
    command: 'rebuild',
    params: {
      file: psModule.srcPath
    }
  });
}
module.exports.rebuild = rebuild;

function formatIdeResult(result, options, index, length) {
  var numAndErr = '[' + (index + 1) + '/' + length + ' ' + result.errorCode + ']';
  numAndErr = options.pscIdeColors ? colors.yellow(numAndErr) : numAndErr;

  function makeResult() {
    return Promise.resolve('\n' + numAndErr + ' ' + result.message);
  }

  function makeResultSnippet(filename, pos) {
    var srcPath = path.relative(options.context, filename);
    var fileAndPos = srcPath + ':' + pos.startLine + ':' + pos.startColumn;

    return fs.readFileAsync(filename, 'utf8').then(function (source) {
      var lines = source.split('\n').slice(pos.startLine - 1, pos.endLine);
      var endsOnNewline = pos.endColumn === 1 && pos.startLine !== pos.endLine;
      var up = options.pscIdeColors ? colors.red('^') : '^';
      var down = options.pscIdeColors ? colors.red('v') : 'v';
      var trimmed = lines.slice(0);

      if (endsOnNewline) {
        lines.splice(lines.length - 1, 1);
        pos.endLine = pos.endLine - 1;
        pos.endColumn = lines[lines.length - 1].length || 1;
      }

      // strip newlines at the end
      if (endsOnNewline) {
        trimmed = lines.reverse().reduce(function (trimmed, line, i) {
          if (i === 0 && line === '') trimmed.trimming = true;
          if (!trimmed.trimming) trimmed.push(line);
          if (trimmed.trimming && line !== '') {
            trimmed.trimming = false;
            trimmed.push(line);
          }
          return trimmed;
        }, []).reverse();
        pos.endLine = pos.endLine - (lines.length - trimmed.length);
        pos.endColumn = trimmed[trimmed.length - 1].length || 1;
      }

      var spaces = ' '.repeat(String(pos.endLine).length);
      var snippet = trimmed.map(function (line, i) {
        return '  ' + (pos.startLine + i) + '  ' + line;
      }).join('\n');

      if (trimmed.length === 1) {
        snippet += '\n  ' + spaces + '  ' + ' '.repeat(pos.startColumn - 1) + up.repeat(pos.endColumn - pos.startColumn + 1);
      } else {
        snippet = '  ' + spaces + '  ' + ' '.repeat(pos.startColumn - 1) + down + '\n' + snippet;
        snippet += '\n  ' + spaces + '  ' + ' '.repeat(pos.endColumn - 1) + up;
      }

      return Promise.resolve('\n' + numAndErr + ' ' + fileAndPos + '\n\n' + snippet + '\n\n' + result.message);
    });
  }

  return result.filename && result.position ? makeResultSnippet(result.filename, result.position) : makeResult();
}
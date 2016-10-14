'use strict';

const path = require('path');

const Promise = require('bluebird')

const fs = Promise.promisifyAll(require('fs'))

const spawn = require('cross-spawn')

const debug = require('debug')('purs-loader');

const dargs = require('./dargs');

function compile(psModule, _compilation) {
  const options = psModule.options
  const cache = psModule.cache
  const stderr = []

  if (cache.compilationStarted) return Promise.resolve(psModule)

  cache.compilationStarted = true

  const args = dargs(Object.assign({
    _: options.src,
    output: options.output,
  }, options.pscArgs))

  debug('spawning compiler %s %o', options.psc, args)

  return (new Promise((resolve, reject) => {
    console.log('\nCompiling PureScript...')

    const compilation = spawn(options.psc, args)

    compilation.stdout.on('data', data => stderr.push(data.toString()))
    compilation.stderr.on('data', data => stderr.push(data.toString()))

    compilation.on('close', code => {
      console.log('Finished compiling PureScript.')
      cache.compilationFinished = true
      if (code !== 0) {
        cache.errors = stderr.join('')
        reject(true)
      } else {
        cache.warnings = stderr.join('')
        resolve(psModule)
      }
    })
  }))
  .then(compilerOutput => {
    if (options.bundle) {
      return waitForModules(_compilation)
        .then(() => bundle(options, cache))
        .then(() => psModule)
    }
    return psModule
  })
}
module.exports.compile = compile;

function waitForModules(_compilation) {
  function isReady() {
    const modules = _compilation.modules
    for (let i = 0; i < modules.length; i++) {
      const module = modules[i]
      if (module.building && !/\.purs$/.test(module.rawRequest)) {
        return false
      }
    }
    return true
  }

  function check(resolve, reject) {
    if (isReady()) {
      resolve()
    } else {
      // TODO replace busy waiting with event subscription
      setTimeout(() => {
        check(resolve, reject)
      }, 200)
    }
  }

  return new Promise(check)
}

function bundle(options, cache) {
  // TODO looks to be incorrect, must not go further if bundling is started
  if (cache.bundle) return Promise.resolve(cache.bundle)

  cache.isBundlingStarted = true

  const stdout = []
  const stderr = cache.bundle = []

  const args = dargs(Object.assign({
    _: [path.join(options.output, '*', '*.js')],
    output: options.bundleOutput,
    namespace: options.bundleNamespace,
  }, options.pscBundleArgs))

  cache.bundleModules.forEach(name => args.push('--module', name))

  debug('spawning bundler %s %o', options.pscBundle, args.join(' '))

  return (new Promise((resolve, reject) => {
    console.log('Bundling PureScript...')

    const compilation = spawn(options.pscBundle, args)

    compilation.stdout.on('data', data => stdout.push(data.toString()))
    compilation.stderr.on('data', data => stderr.push(data.toString()))
    compilation.on('close', code => {
      if (code !== 0) {
        cache.errors = (cache.errors || '') + stderr.join('')
        return reject(true)
      }
      cache.bundle = stderr
      resolve(fs.appendFileAsync(options.bundleOutput, `module.exports = ${options.bundleNamespace}`))
    })
  }))
}

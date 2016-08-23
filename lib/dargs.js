'use strict';

function dargs(obj) {
  return Object.keys(obj).reduce(function (args, key) {
    var arg = '--' + key.replace(/[A-Z]/g, '-$&').toLowerCase();
    var val = obj[key];

    if (key === '_') val.forEach(function (v) {
      return args.push(v);
    });else if (Array.isArray(val)) val.forEach(function (v) {
      return args.push(arg, v);
    });else args.push(arg, obj[key]);

    return args.filter(function (arg) {
      return typeof arg !== 'boolean';
    });
  }, []);
}

module.exports = dargs;
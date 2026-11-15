'use strict';

const { fib } = require('../src/fib');

if (fib(20) !== 6765) {
  console.error('fib(20) is not 6765');
  process.exit(1);
}

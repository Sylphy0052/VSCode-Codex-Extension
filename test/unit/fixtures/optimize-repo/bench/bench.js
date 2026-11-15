'use strict';

const fs = require('fs');
const { fib, getCalls, resetCalls } = require('../src/fib');

resetCalls();
fib(20);
fs.writeFileSync('m.json', JSON.stringify({ value: getCalls() }));

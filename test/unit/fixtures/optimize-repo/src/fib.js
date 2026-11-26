'use strict';

let calls = 0;

function fib(n) {
  calls += 1;
  if (n < 2) {
    return n;
  }
  return fib(n - 1) + fib(n - 2);
}

module.exports = {
  fib,
  getCalls: () => calls,
  resetCalls: () => {
    calls = 0;
  },
};

// Plain JS test fixture for integration tests
// Runs under --inspect-brk so line numbers are stable

const x = 10;         // line 4
const y = 20;         // line 5
const sum = x + y;    // line 6
console.log("sum:", sum); // line 7

function greet(name) {  // line 9
  const msg = `hello ${name}`; // line 10
  return msg;           // line 11
}

const result = greet("world"); // line 14
console.log(result);           // line 15

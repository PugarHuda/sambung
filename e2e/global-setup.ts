// Picks the world key for the whole run, exactly once.
//
// The config module is re-evaluated in every worker process, so deriving the key
// there from Date.now()/pid produced a different world per worker: a suite could
// write a record in one worker and then read an empty world in the next, which
// looks like a product bug and is not one. globalSetup runs once in the main
// process and its environment is inherited by every worker, so the key is stable.

export default function globalSetup() {
  process.env.SAMBUNG_TEST_WORLD ??= `pwtest-${Date.now().toString(36)}`
  // Echoed so a failing run can be traced back to the exact world it wrote to.
  console.log(`e2e world prefix: ${process.env.SAMBUNG_TEST_WORLD}`)
}

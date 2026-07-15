const assert = require("node:assert/strict");
const test = require("node:test");

const {
  canManageContainer,
  canManageProfile,
  canManageResource,
  filterContainersForActor,
  filterProfilesForActor,
  filterResourcesForActor,
} = require("../src/policy");

const admin = { id: "usr_admin", role: "admin" };
const alice = { id: "usr_alice", role: "employee" };
const bob = { id: "usr_bob", role: "employee" };

test("employees only see and manage their own containers and profiles", () => {
  const containers = [
    { id: "ctr_alice", ownerId: "usr_alice" },
    { id: "ctr_bob", ownerId: "usr_bob" },
  ];
  const profiles = [
    { id: "pro_alice", ownerId: "usr_alice" },
    { id: "pro_bob", ownerId: "usr_bob" },
  ];

  assert.deepEqual(filterContainersForActor(admin, containers).map((item) => item.id), [
    "ctr_alice",
    "ctr_bob",
  ]);
  assert.deepEqual(filterContainersForActor(alice, containers).map((item) => item.id), [
    "ctr_alice",
  ]);
  assert.deepEqual(filterProfilesForActor(alice, profiles).map((item) => item.id), ["pro_alice"]);
  assert.equal(canManageContainer(alice, containers[0]), true);
  assert.equal(canManageContainer(alice, containers[1]), false);
  assert.equal(canManageProfile(alice, profiles[0]), true);
  assert.equal(canManageProfile(alice, profiles[1]), false);
});

test("employees can share company resources but cannot edit other private resources", () => {
  const resources = [
    { id: "res_private_alice", ownerId: "usr_alice", visibility: "private" },
    { id: "res_shared_bob", ownerId: "usr_bob", visibility: "company" },
    { id: "res_private_bob", ownerId: "usr_bob", visibility: "private" },
  ];

  assert.deepEqual(filterResourcesForActor(alice, resources).map((item) => item.id), [
    "res_private_alice",
    "res_shared_bob",
  ]);
  assert.equal(canManageResource(alice, resources[0]), true);
  assert.equal(canManageResource(alice, resources[1]), false);
  assert.equal(canManageResource(admin, resources[2]), true);
});

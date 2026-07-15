function isAdmin(actor) {
  return actor?.role === "admin";
}

function canManageContainer(actor, container) {
  return isAdmin(actor) || Boolean(actor && container && actor.id === container.ownerId);
}

function canManageProfile(actor, profile) {
  return isAdmin(actor) || Boolean(actor && profile && actor.id === profile.ownerId);
}

function canManageResource(actor, resource) {
  return isAdmin(actor) || Boolean(actor && resource && actor.id === resource.ownerId);
}

function canViewResource(actor, resource) {
  return canManageResource(actor, resource) || resource?.visibility === "company";
}

function filterContainersForActor(actor, containers) {
  if (isAdmin(actor)) {
    return containers;
  }
  return containers.filter((container) => container.ownerId === actor?.id);
}

function filterProfilesForActor(actor, profiles) {
  if (isAdmin(actor)) {
    return profiles;
  }
  return profiles.filter((profile) => profile.ownerId === actor?.id);
}

function filterResourcesForActor(actor, resources) {
  if (isAdmin(actor)) {
    return resources;
  }
  return resources.filter((resource) => canViewResource(actor, resource));
}

module.exports = {
  canManageContainer,
  canManageProfile,
  canManageResource,
  canViewResource,
  filterContainersForActor,
  filterProfilesForActor,
  filterResourcesForActor,
  isAdmin,
};

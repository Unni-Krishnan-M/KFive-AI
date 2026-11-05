const databaseName = process.env.MONGO_INITDB_DATABASE;
const applicationUsername = process.env.MONGO_APP_USERNAME;
const applicationPassword = process.env.MONGO_APP_PASSWORD;

if (!databaseName || !applicationUsername || !applicationPassword) {
  throw new Error('Mongo application user configuration is required');
}

db.getSiblingDB(databaseName).createUser({
  user: applicationUsername,
  pwd: applicationPassword,
  roles: [{ role: 'readWrite', db: databaseName }],
});

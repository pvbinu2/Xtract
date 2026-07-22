const { MongoClient, ObjectId } = require('mongodb');

class MongoDatabase {
  constructor(options = {}) {
    this.uri = options.uri || MongoDatabase.resolveUri();
    this.databaseName = options.databaseName;
    this.clientPromise = undefined;
  }

  static resolveUri() {
    return process.env.MONGODB_URI || 'mongodb://localhost:27017/xtract';
  }

  connect() {
    if (!this.clientPromise) {
      this.clientPromise = new MongoClient(this.uri).connect().catch((error) => {
        this.clientPromise = undefined;
        throw error;
      });
    }
    return this.clientPromise;
  }

  async database() {
    return (await this.connect()).db(this.databaseName);
  }

  async collection(name) {
    return (await this.database()).collection(name);
  }

  async close() {
    if (!this.clientPromise) return;
    const client = await this.clientPromise;
    this.clientPromise = undefined;
    await client.close();
  }
}

module.exports = { MongoDatabase, ObjectId };

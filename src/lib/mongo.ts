import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from './logger.js';

// Only fields defined in a schema can be used in filters.
// Query-operator injection (e.g. { "$gt": "" } sent as a password) is blocked earlier:
// every request body is checked by a Zod schema that only accepts plain strings/numbers.
mongoose.set('strictQuery', true);

export async function connectMongo(uri: string = env.MONGODB_URI): Promise<void> {
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  logger.info({ db: mongoose.connection.name }, 'MongoDB connected');
}

export async function disconnectMongo(): Promise<void> {
  mongoose.connection.removeAllListeners('disconnected'); // planned shutdown, not a warning
  await mongoose.disconnect();
}

export async function pingMongo(): Promise<boolean> {
  try {
    await mongoose.connection.db?.admin().ping();
    return mongoose.connection.readyState === mongoose.ConnectionStates.connected;
  } catch {
    return false;
  }
}

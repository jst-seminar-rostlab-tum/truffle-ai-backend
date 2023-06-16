import Fastify, { FastifyReply, FastifyRequest } from 'fastify'
import mercurius from 'mercurius'
import resolvers from './graphql/resolvers'
import schema from './graphql/schema'
import supbaseClient from './supabase'
import fastifyCookies from '@fastify/cookie'
import { UserResponse } from '@supabase/supabase-js'
const ENV = process.env.NODE_ENV || 'development'

const envToLogger = {
  development: {
    transport: {
      target: 'pino-pretty',
      options: {
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname'
      }
    }
  },
  production: true
}

const app = Fastify({
  logger: envToLogger[ENV]
})

void app.register(fastifyCookies, {
  hook: 'onRequest',
  parseOptions: {}
})

const buildContext = async (request: FastifyRequest, reply: FastifyReply) => {
  const jwt = request?.cookies?.jwt
  if (jwt) {
    const response: void | UserResponse = await supbaseClient.auth.getUser(jwt).catch((error) => {
      reply.log.error(error)
    })
    if (response?.error) {
      reply.log.error(response?.error)
    }

    return {
      user: response?.data?.user
    }
  }
  return null
}

// https://github.com/mercurius-js/mercurius-typescript/tree/master/examples
void app.register(mercurius, {
  schema,
  resolvers,
  context: buildContext,
  // @TODO for security
  // validationRules: process.env.NODE_ENV === 'production' ? [NoSchemaIntrospectionCustomRule] : [],
  graphiql: true // see http://localhost:3001/graphiql
})
export default app

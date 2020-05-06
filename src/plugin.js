import { getPluginContext, setPluginContext } from 'kea'
import isEqual from 'lodash/isEqual'
import queryString from 'query-string'
import UrlPattern from 'url-pattern'

import { router } from './router'

const memoryHistroy = {
  pushState (state, _, url) {},
  replaceState (state, _, url) {}
}

let lastLocation = {}
let lastQuery = {}
let skipUpdateQuery = false

export function routerPlugin ({
  history: _history,
  location: _location,
  pathFromRoutesToWindow = path => path,
  pathFromWindowToRoutes = path => path,
  queryStringOptions = {}
} = {}) {
  const history = _history || (typeof window !== 'undefined' ? window.history : memoryHistroy)
  const location = _location || (typeof window !== 'undefined' ? window.location : {})

  return {
    name: 'router',
    events: {
      afterPlugin () {
        setPluginContext('router', {
          history,
          location,
          valueToQueryOptions: {}
        })
      },

      beforeReduxStore (options) {
        options.middleware.push(store => next => action => {
          const {
            history,
            location,
            valueToQueryOptions
          } = getPluginContext('router')
          const state = store.getState()
          const result = next(action)
          const nextState = store.getState()

          if (!skipUpdateQuery && action.type !== (router.actions && router.actions.locationChanged.toString())) {
            const locationInRoutes = Object.assign({}, location, {
              pathname: pathFromWindowToRoutes(location.pathname)
            })
            const isPageDifferent = locationInRoutes.pathname !== lastLocation.pathname
            if (nextState !== state || isPageDifferent || action.type === (router.actions && router.actions.updateQuery.toString())) {
              lastLocation = locationInRoutes
              if (Object.keys(valueToQueryOptions).length) {
                const { pathname, search } = locationInRoutes
                let shouldPush = false
                const query = queryString.parse(search, queryStringOptions)
                Object.values(valueToQueryOptions).forEach(array => array.forEach(options => {
                  const { key, pattern, selector, defaultValue, valueToString = v => `${v}`, push = false } = options
                  if (pattern.match(pathname)) {
                    const itemState = selector(nextState)
                    const value = isEqual(itemState, defaultValue) ? undefined : valueToString(itemState)
                    if (query[key] !== value) {
                      query[key] = value
                      shouldPush |= push
                    }
                  }
                }))
                const nextSearch = '?' + queryString.stringify(query, queryStringOptions)
                const nextLocation = Object.assign({}, locationInRoutes, {
                  pathname: pathFromRoutesToWindow(locationInRoutes.pathname),
                  search: nextSearch === '?' ? '' : nextSearch
                })
                lastQuery = query
                if (!isEqual(nextLocation, location)) {
                  const method = (shouldPush && !isPageDifferent) ? 'push' : 'replace'
                  history[`${method}State`]({}, '', createPath(nextLocation))
                }
              }
            }
          }

          return result
        })
      },

      afterReduxStore () {
        router.mount()
      },

      afterLogic (logic, input) {
        if (!input.actionToUrl && !input.urlToAction && !input.urlQuerySync) {
          return
        }

        if (input.urlToAction) {
          logic.cache.__routerListeningToLocation = true
        }

        logic.extend({
          connect: {
            actions: [router, ['push as __routerPush', 'locationChanged as __routerLocationChanged', 'updateQuery as __routerUpdateQuery']],
            values: [router, ['location as __routerLocation']]
          },

          listeners: ({ actions }) => {
            const listeners = {}
            let routes
            let queryToActions

            if (input.urlQuerySync) {
              const urlQuerySyncMapping = input.urlQuerySync(logic)
              const {
                valueToQuery,
                queryToAction
              } = Object.entries(urlQuerySyncMapping).reduce(({ valueToQuery, queryToAction }, [key, options]) => {
                if (options.path) {
                  const { path, selector, defaultValue, push, action, resetAction, valueToString, stringToArguments } = options
                  const pattern = new UrlPattern(path)
                  if (selector) {
                    valueToQuery.push({ key, path, selector, defaultValue, push, pattern, valueToString })
                  }
                  if (action) {
                    queryToAction.push({ key, path, action, resetAction, pattern, stringToArguments })
                  }
                }
                return { valueToQuery, queryToAction }
              }, { valueToQuery: [], queryToAction: [] })

              valueToQuery.length && (logic.cache.valueToQuery = valueToQuery)
              queryToAction.length && (queryToActions = queryToAction)
            }

            if (input.urlToAction) {
              const urlToActionMapping = input.urlToAction(logic)
              routes = Object.keys(urlToActionMapping).map(pathFromRoutes => ({
                path: pathFromRoutes,
                pattern: new UrlPattern(pathFromRoutes),
                action: urlToActionMapping[pathFromRoutes]
              }))
            }

            if (routes || queryToActions) {
              listeners[actions.__routerLocationChanged] = function ({ pathname, search }) {
                const pathInWindow = decodeURI(pathname)
                const pathInRoutes = pathFromWindowToRoutes(pathInWindow)
                const isPageDifferent = pathInRoutes !== lastLocation.pathname

                if (routes) {
                  let matchedRoute
                  let params

                  for (const route of routes) {
                    params = route.pattern.match(pathInRoutes)
                    if (params) {
                      matchedRoute = route
                      break
                    }
                  }

                  skipUpdateQuery = true
                  matchedRoute && matchedRoute.action(params)
                  skipUpdateQuery = false
                }

                if (queryToActions && !isPageDifferent) {
                  const actionsAndArgs = []
                  const query = queryString.parse(search, queryStringOptions)

                  for (const options of queryToActions) {
                    const { key, pattern, action, resetAction = options.action, stringToArguments = v => [v] } = options
                    if (pattern.match(pathInRoutes)) {
                      if (lastQuery[key] !== query[key]) {
                        if (query[key] !== undefined) {
                          const args = stringToArguments(query[key])
                          actionsAndArgs.push([action, args])
                        } else {
                          actionsAndArgs.push([resetAction])
                        }
                      }
                    }
                  }

                  skipUpdateQuery = true
                  actionsAndArgs.forEach(([action, args]) => {
                    args ? action(...args) : action()
                  })
                  skipUpdateQuery = false

                  if (actionsAndArgs.length) {
                    actions.__routerUpdateQuery()
                  }
                }
              }
            }

            if (input.actionToUrl) {
              for (const [actionKey, urlMapping] of Object.entries(input.actionToUrl(logic))) {
                listeners[actionKey] = function (payload) {
                  const { pathname, search } = logic.values.__routerLocation
                  const currentPathInWindow = pathname + search

                  const pathInRoutes = urlMapping(payload)

                  if (typeof pathInRoutes === 'undefined') {
                    return
                  }

                  const pathInWindow = pathFromRoutesToWindow(pathInRoutes)

                  if (currentPathInWindow !== pathInWindow) {
                    actions.__routerPush(pathInWindow)
                  }
                }
              }
            }

            return listeners
          },

          events: ({ actions, listeners, cache, values }) => ({
            afterMount () {
              const locationChanged = actions.__routerLocationChanged

              if (listeners && listeners[locationChanged] && cache.__routerListeningToLocation) {
                const routerLocation = values.__routerLocation
                listeners[locationChanged].forEach(l =>
                  l({ type: locationChanged.toString(), payload: { ...routerLocation, method: 'POP', initial: true } })
                )
              }
            }
          })
        })
      },

      beforeAttach (logic) {
        const { valueToQueryOptions } = getPluginContext('router')
        if (logic.cache.valueToQuery) {
          valueToQueryOptions[logic.pathString] = logic.cache.valueToQuery
        }
      },

      afterDettach (logic) {
        const { valueToQueryOptions } = getPluginContext('router')
        delete valueToQueryOptions[logic.pathString]
      }
    }
  }
}

// copied from react-router! :)
function createPath (location) {
  const { pathname, search, hash } = location

  let path = pathname || '/'

  if (search && search !== '?') {
    path += search.charAt(0) === '?' ? search : `?${search}`
  }

  if (hash && hash !== '#') path += hash.charAt(0) === '#' ? hash : `#${hash}`

  return path
}

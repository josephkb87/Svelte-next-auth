import { Auth, type AuthConfig } from "@auth/core"
import { headers } from "next/headers"
import { NextResponse } from "next/server"
import { detectOrigin, reqWithEnvUrl } from "./env.js"

import type { AuthAction, Awaitable, Session } from "@auth/core/types"
import type {
  GetServerSidePropsContext,
  NextApiRequest,
  NextApiResponse,
} from "next"
import type { AppRouteHandlerFn } from "next/dist/server/future/route-modules/app-route/module"
import type { NextFetchEvent, NextMiddleware, NextRequest } from "next/server"

/** Configure NextAuth.js. */
export interface NextAuthConfig extends AuthConfig {
  /**
   * Callbacks are asynchronous functions you can use to control what happens when an auth-related action is performed.
   * Callbacks **allow you to implement access controls without a database** or to **integrate with external databases or APIs**.
   */
  callbacks?: AuthConfig["callbacks"] & {
    /**
     * Invoked when a user needs authorization, using [Middleware](https://nextjs.org/docs/advanced-features/middleware).
     *
     * You can override this behavior by returning a {@link NextResponse}.
     *
     * @example
     * ```ts title="app/auth.ts"
     * ...
     * async authorized({ request, auth }) {
     *   const url = request.nextUrl
     *
     *   if(request.method === "POST") {
     *     const { authToken } = (await request.json()) ?? {}
     *     // If the request has a valid auth token, it is authorized
     *     const valid = await validateAuthToken(authToken)
     *     if(valid) return true
     *     return NextResponse.json("Invalid auth token", { status: 401 })
     *   }
     *
     *   // Logged in users are authenticated, otherwise redirect to login page
     *   return !!auth.user
     * }
     * ...
     * ```
     *
     * :::warning
     * If you are returning a redirect response, make sure that the page you are redirecting to is not protected by this callback,
     * otherwise you could end up in an infinite redirect loop.
     * :::
     */
    authorized?: (params: {
      /** The request to be authorized. */
      request: NextRequest
      /** The authenticated user or token, if any. */
      auth: Session | null
    }) => Awaitable<boolean | NextResponse | Response | undefined>
  }
}

/** Server-side method to read the session. */
async function getSession(headers: Headers, config: NextAuthConfig) {
  const origin = detectOrigin(headers)
  const request = new Request(`${origin}/session`, {
    headers: { cookie: headers.get("cookie") ?? "" },
  })

  return Auth(request, {
    ...config,
    callbacks: {
      ...config.callbacks,
      // Since we are server-side, we don't need to filter out the session data
      // See https://authjs.dev/guides/upgrade-to-v5/v5#authenticating-server-side
      // TODO: Taint the session data to prevent accidental leakage to the client
      // https://react.devreference/nextjs/react/experimental_taintObjectReference
      async session(...args) {
        const session =
          // If the user defined a custom session callback, use that instead
          (await config.callbacks?.session?.(...args)) ?? args[0].session
        const user = args[0].user ?? args[0].token
        return { user, ...session } satisfies Session
      },
    },
  })
}

export interface NextAuthRequest extends NextRequest {
  auth: Session | null
}

export type NextAuthMiddleware = (
  request: NextAuthRequest,
  event: NextFetchEvent
) => ReturnType<NextMiddleware>

export type WithAuthArgs =
  | [NextAuthRequest, any]
  | [NextAuthMiddleware]
  | [AppRouteHandlerFn]
  | [NextApiRequest, NextApiResponse]
  | [GetServerSidePropsContext]
  | []

function isReqWrapper(arg: any): arg is NextAuthMiddleware | AppRouteHandlerFn {
  return typeof arg === "function"
}

export function initAuth(config: NextAuthConfig) {
  return (...args: WithAuthArgs) => {
    if (!args.length) {
      // React Server Components
      return getSession(headers(), config).then((r) => r.json())
    }
    if (args[0] instanceof Request) {
      // middleare.ts
      // export { auth as default } from "auth"
      const req = args[0]
      const ev = args[1]
      return handleAuth([req, ev], config)
    }

    if (isReqWrapper(args[0])) {
      // middleware.ts/router.ts
      // import { auth } from "auth"
      // export default auth((req) => { console.log(req.auth) }})
      const userMiddlewareOrRoute = args[0]
      return async (
        ...args: Parameters<NextAuthMiddleware | AppRouteHandlerFn>
      ) => {
        return handleAuth(args, config, userMiddlewareOrRoute)
      }
    }

    // API Routes, getServerSideProps
    const request = "req" in args[0] ? args[0].req : args[0]
    const response: any = "res" in args[0] ? args[0].res : args[1]

    return getSession(
      // @ts-expect-error
      new Headers(request.headers),
      config
    ).then(async (authResponse) => {
      const auth = await authResponse.json()

      // Preserve cookies set by Auth.js Core
      cloneSetCookie(authResponse, response)

      return auth satisfies Session | null
    })
  }
}

async function handleAuth(
  args: Parameters<NextMiddleware | AppRouteHandlerFn>,
  config: NextAuthConfig,
  userMiddlewareOrRoute?: NextAuthMiddleware | AppRouteHandlerFn
) {
  const request = reqWithEnvUrl(args[0])
  const sessionResponse = await getSession(request.headers, config)
  const auth = await sessionResponse.json()

  let authorized: boolean | NextResponse | Response | undefined = true

  if (config.callbacks?.authorized) {
    authorized = await config.callbacks.authorized({ request, auth })
  }

  let response: any = NextResponse.next?.()

  if (authorized instanceof Response) {
    // User returned a custom response, like redirecting to a page or 401, respect it
    response = authorized

    const redirect = authorized.headers.get("Location")
    const { pathname } = request.nextUrl
    // If the user is redirecting to the same NextAuth.js action path as the current request,
    // don't allow the redirect to prevent an infinite loop
    if (
      redirect &&
      isSameAuthAction(pathname, new URL(redirect).pathname, config)
    ) {
      authorized = true
    }
  } else if (userMiddlewareOrRoute) {
    // Execute user's middleware/handler with the augmented request
    const augmentedReq = request as NextAuthRequest
    augmentedReq.auth = auth
    response =
      // @ts-expect-error
      (await userMiddlewareOrRoute(augmentedReq, args[1])) ??
      NextResponse.next()
  } else if (!authorized) {
    const signInPage =
      config.pages?.signIn ?? `${request.nextUrl.basePath}}/signin`
    if (request.nextUrl.pathname !== signInPage) {
      // Redirect to signin page by default if not authorized
      request.nextUrl.pathname = signInPage
      request.nextUrl.searchParams.set("callbackUrl", request.nextUrl.href)
      response = NextResponse.redirect(request.nextUrl)
    }
  }

  const finalResponse = new Response(response?.body, response)
  // Preserve cookies set by Auth.js Core
  cloneSetCookie(sessionResponse, finalResponse)

  return finalResponse
}

/** Clone cookies from one response to another. */
function cloneSetCookie(from: Response, to: Response) {
  const authCookies =
    from.headers.getSetCookie?.() ?? from.headers.get("set-cookie")

  if (!authCookies?.length) return

  if (Array.isArray(authCookies)) {
    authCookies.forEach((cookie) => to.headers.append("set-cookie", cookie))
  } else {
    to.headers.set("set-cookie", authCookies)
  }
}

function isSameAuthAction(
  requestPath: string,
  redirectPath: string,
  config: NextAuthConfig
) {
  const action = redirectPath.replace(`${requestPath}/`, "") as AuthAction
  const pages = Object.values(config.pages ?? {})

  return (
    (actions.has(action) || pages.includes(redirectPath)) &&
    redirectPath === requestPath
  )
}

const actions = new Set<AuthAction>([
  "providers",
  "session",
  "csrf",
  "signin",
  "signout",
  "callback",
  "verify-request",
  "error",
])

import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  const isProtectedRoute = request.nextUrl.pathname.startsWith('/settings') ||
    request.nextUrl.pathname.startsWith('/api/settings') ||
    request.nextUrl.pathname.startsWith('/onboarding') ||
    request.nextUrl.pathname.startsWith('/api/onboarding') ||
    request.nextUrl.pathname.startsWith('/variables') ||
    request.nextUrl.pathname.startsWith('/api/variables')

  const isPublicRoute = request.nextUrl.pathname === '/login' ||
    request.nextUrl.pathname.startsWith('/api/cron') ||
    request.nextUrl.pathname.startsWith('/api/agents') ||
    request.nextUrl.pathname.startsWith('/api/pipeline') ||
    request.nextUrl.pathname.startsWith('/api/telegram') ||
    request.nextUrl.pathname.startsWith('/api/dashboard')

  if (!user && isProtectedRoute) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  if (user && request.nextUrl.pathname === '/login') {
    const url = request.nextUrl.clone()
    url.pathname = '/'
    return NextResponse.redirect(url)
  }

  return supabaseResponse
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}

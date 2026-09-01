// Single source of truth for desktop settings routes. The renderer mounts
// these real settings components under `/settings/*` while keeping chat
// mounted. Add current reusable settings pages here when desktop needs to
// expose them; do not mirror retired web redirects as new desktop routes.

import { h, type Component } from 'vue'
import { RouterView, type RouteRecordRaw } from 'vue-router'
import { i18nRef } from '@sophiaai/web/i18n'

export interface SettingsRouteSpec {
  name?: string
  path: string
  loader?: () => Promise<Component | { default: Component }>
  meta?: {
    breadcrumb?: string | { value: string } | ((route: { params: Record<string, string | string[] | undefined> }) => string | undefined)
    adminOnly?: boolean
  }
  children?: SettingsRouteSpec[]
}

export const SETTINGS_ROUTE_SPECS: SettingsRouteSpec[] = [
  {
    path: '/settings/bots',
    meta: { breadcrumb: i18nRef('sidebar.bots') },
    children: [
      {
        name: 'bots',
        path: '',
        loader: () => import('@sophiaai/web/pages/bots/index.vue'),
      },
      {
        name: 'bot-new',
        path: 'new',
        loader: () => import('@sophiaai/web/pages/bots/new.vue'),
        meta: { breadcrumb: i18nRef('bots.createBot') }
      },
      {
        name: 'bot-create-progress',
        path: 'new/progress',
        loader: () => import('@sophiaai/web/pages/bots/new-progress.vue'),
        meta: { breadcrumb: i18nRef('bots.createBot') }
      },
      {
        name: 'bot-detail',
        path: ':botName',
        loader: () => import('@sophiaai/web/pages/bots/detail.vue'),
        meta: { breadcrumb: (route: { params: { botName?: string } }) => route.params.botName }
      },
    ]
  },
  {
    name: 'providers',
    path: '/settings/providers',
    loader: () => import('@sophiaai/web/pages/providers/index.vue'),
    meta: { breadcrumb: i18nRef('sidebar.providers') }
  },
  {
    name: 'runtimes',
    path: '/settings/runtimes',
    loader: () => import('@sophiaai/web/pages/runtimes/index.vue'),
    meta: { breadcrumb: i18nRef('sidebar.runtimes') }
  },
  {
    name: 'people',
    path: '/settings/people',
    loader: () => import('@sophiaai/web/pages/people/index.vue'),
    meta: { breadcrumb: i18nRef('sidebar.people'), adminOnly: true }
  },
  {
    name: 'web-search',
    path: '/settings/web-search',
    loader: () => import('@sophiaai/web/pages/web-search/index.vue'),
    meta: { breadcrumb: i18nRef('sidebar.webSearch') }
  },
  {
    name: 'memory',
    path: '/settings/memory',
    loader: () => import('@sophiaai/web/pages/memory/index.vue'),
    meta: { breadcrumb: i18nRef('sidebar.memory') }
  },
  {
    name: 'voice',
    path: '/settings/voice',
    loader: () => import('@sophiaai/web/pages/voice/index.vue'),
    meta: { breadcrumb: i18nRef('sidebar.voice') }
  },
  {
    name: 'email',
    path: '/settings/email',
    loader: () => import('@sophiaai/web/pages/email/index.vue'),
    meta: { breadcrumb: i18nRef('sidebar.email') }
  },
  {
    name: 'usage',
    path: '/settings/usage',
    loader: () => import('@sophiaai/web/pages/usage/index.vue'),
    meta: { breadcrumb: i18nRef('sidebar.usage') }
  },
  {
    name: 'appearance',
    path: '/settings/appearance',
    loader: () => import('@sophiaai/web/pages/appearance/index.vue'),
    meta: { breadcrumb: i18nRef('sidebar.appearance') }
  },
  {
    name: 'keyboard',
    path: '/settings/keyboard',
    loader: () => import('@sophiaai/web/pages/keyboard-shortcuts/index.vue'),
    meta: { breadcrumb: i18nRef('sidebar.keyboard') }
  },
  {
    name: 'profile',
    path: '/settings/profile',
    loader: () => import('@sophiaai/web/pages/profile/index.vue'),
    meta: { breadcrumb: i18nRef('sidebar.profile') }
  },
  {
    name: 'platform',
    path: '/settings/platform',
    loader: () => import('@sophiaai/web/pages/platform/index.vue'),
    meta: { breadcrumb: i18nRef('sidebar.platform') }
  },
  {
    path: '/settings/supermarket',
    meta: { breadcrumb: i18nRef('sidebar.supermarket') },
    children: [
      {
        name: 'supermarket',
        path: '',
        loader: () => import('@sophiaai/web/pages/supermarket/index.vue'),
      },
      {
        name: 'supermarket-plugin-detail',
        path: 'plugins/:pluginId',
        loader: () => import('@sophiaai/web/pages/supermarket/plugin-detail.vue'),
        meta: {
          breadcrumb: (route) => String(route.params.pluginId ?? ''),
        },
      },
      {
        name: 'supermarket-skill-detail',
        path: 'skills/:skillId',
        loader: () => import('@sophiaai/web/pages/supermarket/skill-detail.vue'),
        meta: {
          breadcrumb: (route) => String(route.params.skillId ?? ''),
        },
      },
    ],
  },
  {
    name: 'about',
    path: '/settings/about',
    loader: () => import('@sophiaai/web/pages/about/index.vue'),
    meta: { breadcrumb: i18nRef('sidebar.about') }
  },
]

// Default landing path used by the chat router's `/settings` redirect and by
// generic desktop settings open requests.
export const SETTINGS_DEFAULT_PATH = '/settings/bots'

export function mapSettingsSpecToRoute(spec: SettingsRouteSpec): RouteRecordRaw {
  return {
    path: spec.path,
    component: spec.loader ?? { render: () => h(RouterView) },
    ...(spec.name ? { name: spec.name } : {}),
    ...(spec.meta ? { meta: spec.meta } : {}),
    ...(spec.children ? { children: spec.children.map(mapSettingsSpecToRoute) } : {}),
  } satisfies RouteRecordRaw
}

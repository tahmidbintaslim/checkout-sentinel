import {
  createRouter,
  createWebHistory,
  type RouteRecordRaw,
  type RouterHistory,
} from 'vue-router';
import AlertsView from './views/AlertsView.vue';
import MonitorDetailView from './views/MonitorDetailView.vue';
import MonitorFormView from './views/MonitorFormView.vue';
import MonitorsView from './views/MonitorsView.vue';
import NotFoundView from './views/NotFoundView.vue';
import RunDetailView from './views/RunDetailView.vue';
import SettingsView from './views/SettingsView.vue';

/**
 * The API answers a browser page load of any of these paths with this app, so links such as the
 * run link in alert messages (PUBLIC_BASE_URL/runs/<id>) open the dashboard.
 */
export const routes: RouteRecordRaw[] = [
  { path: '/', name: 'monitors', component: MonitorsView },
  { path: '/monitors/new', name: 'monitor-new', component: MonitorFormView },
  { path: '/monitors/:id', name: 'monitor', component: MonitorDetailView, props: true },
  { path: '/monitors/:id/edit', name: 'monitor-edit', component: MonitorFormView, props: true },
  { path: '/runs/:id', name: 'run', component: RunDetailView, props: true },
  { path: '/alerts', name: 'alerts', component: AlertsView },
  { path: '/settings', name: 'settings', component: SettingsView },
  { path: '/:pathMatch(.*)*', name: 'not-found', component: NotFoundView },
];

export function createAppRouter(history: RouterHistory = createWebHistory()) {
  return createRouter({
    history,
    routes,
    scrollBehavior: (_to, _from, saved) => saved ?? { top: 0 },
  });
}

import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { AppLayout } from './layout';
import { AccountPage } from './pages/Account';
import { BalancesPage } from './pages/Balances';
import { HomePage } from './pages/Home';
import { LoginPage } from './pages/Login';
import { MovementsPage } from './pages/Movements';
import { OptionsPage } from './pages/Options';
import { ProductDetailPage } from './pages/ProductDetail';
import { ProductsPage } from './pages/Products';
import { ReportsPage } from './pages/Reports';
import { ScanSessionPage } from './pages/ScanSession';
import { StocktakePage } from './pages/Stocktake';
import { StocktakesPage } from './pages/Stocktakes';
import { UsersPage } from './pages/Users';
import { meQuery } from './queries';

interface RouterContext {
  queryClient: QueryClient;
}

const optionalString = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Outlet });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});

// Every other page requires a session; without one, go to login.
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: async ({ context }) => {
    try {
      await context.queryClient.ensureQueryData(meQuery);
    } catch {
      // TanStack Router's documented control flow: redirect() is a special object, not an Error.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ to: '/login' });
    }
  },
  component: AppLayout,
});

const routes = [
  createRoute({ getParentRoute: () => appRoute, path: '/', component: HomePage }),
  createRoute({ getParentRoute: () => appRoute, path: '/products', component: ProductsPage }),
  createRoute({ getParentRoute: () => appRoute, path: '/options', component: OptionsPage }),
  createRoute({
    getParentRoute: () => appRoute,
    path: '/products/$productId',
    component: ProductDetailPage,
  }),
  createRoute({
    getParentRoute: () => appRoute,
    path: '/labels',
    validateSearch: (search: Record<string, unknown>) => ({
      productId: optionalString(search.productId),
    }),
    // Loaded on demand: the barcode renderer is ~1 MB and only this page needs it.
    component: lazyRouteComponent(async () => import('./pages/Labels'), 'LabelsPage'),
  }),
  createRoute({
    getParentRoute: () => appRoute,
    path: '/balances',
    validateSearch: (search: Record<string, unknown>) => ({
      locationId: optionalString(search.locationId),
    }),
    component: BalancesPage,
  }),
  createRoute({
    getParentRoute: () => appRoute,
    path: '/sessions/$sessionId',
    component: ScanSessionPage,
  }),
  createRoute({ getParentRoute: () => appRoute, path: '/stocktakes', component: StocktakesPage }),
  createRoute({
    getParentRoute: () => appRoute,
    path: '/movements',
    validateSearch: (search: Record<string, unknown>) => ({
      variantId: optionalString(search.variantId),
      locationId: optionalString(search.locationId),
    }),
    component: MovementsPage,
  }),
  createRoute({ getParentRoute: () => appRoute, path: '/reports', component: ReportsPage }),
  createRoute({ getParentRoute: () => appRoute, path: '/users', component: UsersPage }),
  createRoute({ getParentRoute: () => appRoute, path: '/account', component: AccountPage }),
  createRoute({
    getParentRoute: () => appRoute,
    path: '/stocktakes/$stocktakeId',
    component: StocktakePage,
  }),
];

const routeTree = rootRoute.addChildren([loginRoute, appRoute.addChildren(routes)]);

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({ routeTree, context: { queryClient }, defaultPreload: 'intent' });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}

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
import { StockHomePage } from './pages/Home';
import { SettingsPage } from './pages/Settings';
import { HomePage } from './pages/Today';
import { LoginPage } from './pages/Login';
import { MovementsPage } from './pages/Movements';
import { OptionsPage } from './pages/Options';
import { ProductDetailPage } from './pages/ProductDetail';
import { CategoriesPage } from './pages/Categories';
import { CategoryPage } from './pages/Category';
import { HelpPage } from './pages/Help';
import { ReportsPage } from './pages/Reports';
import { ScanSessionPage } from './pages/ScanSession';
import { StocktakePage } from './pages/Stocktake';
import { StocktakesPage } from './pages/Stocktakes';
import { LocationsPage } from './pages/Locations';
import { RatesPage } from './pages/Rates';
import { UsersPage } from './pages/Users';
import { AccountsPage, StatementPage } from './pages/Accounts';
import { ClosePage } from './pages/Close';
import { EntriesPage, EntryPage } from './pages/Entries';
import { FinancePage } from './pages/Finance';
import { FinanceReportsPage, type ReportTab } from './pages/FinanceReports';
import { VoucherPage, type VoucherKind } from './pages/Voucher';
import { EmployeePage, PayrollPage, PayrollRunPage } from './pages/Payroll';
import { PosPage } from './pages/Pos';
import { PosShiftPage, PosShiftsPage } from './pages/PosShifts';
import { ReceiptPage } from './pages/Receipt';
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
  // «اليوم» for the owner; the till for a cashier; stock work for the warehouse.
  createRoute({ getParentRoute: () => appRoute, path: '/', component: HomePage }),
  createRoute({ getParentRoute: () => appRoute, path: '/stock', component: StockHomePage }),
  createRoute({ getParentRoute: () => appRoute, path: '/settings', component: SettingsPage }),
  createRoute({ getParentRoute: () => appRoute, path: '/products', component: CategoriesPage }),
  createRoute({
    getParentRoute: () => appRoute,
    path: '/categories/$categoryId',
    component: CategoryPage,
  }),
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
      categoryId: optionalString(search.categoryId),
      // Comma-separated: the products to print; none = all of the category.
      productIds: optionalString(search.productIds),
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
  createRoute({ getParentRoute: () => appRoute, path: '/locations', component: LocationsPage }),
  createRoute({ getParentRoute: () => appRoute, path: '/rates', component: RatesPage }),
  createRoute({ getParentRoute: () => appRoute, path: '/account', component: AccountPage }),
  createRoute({ getParentRoute: () => appRoute, path: '/help', component: HelpPage }),
  createRoute({
    getParentRoute: () => appRoute,
    path: '/stocktakes/$stocktakeId',
    component: StocktakePage,
  }),
  // Accounting (ADR-013)
  createRoute({ getParentRoute: () => appRoute, path: '/finance', component: FinancePage }),
  createRoute({
    getParentRoute: () => appRoute,
    path: '/finance/new',
    validateSearch: (search: Record<string, unknown>): { kind: VoucherKind } => ({
      kind: (['RECEIPT', 'PAYMENT', 'TRANSFER', 'EXCHANGE', 'JOURNAL'] as const).includes(
        search.kind as VoucherKind,
      )
        ? (search.kind as VoucherKind)
        : 'RECEIPT',
    }),
    component: VoucherPage,
  }),
  createRoute({ getParentRoute: () => appRoute, path: '/finance/entries', component: EntriesPage }),
  createRoute({
    getParentRoute: () => appRoute,
    path: '/finance/entries/$entryId',
    component: EntryPage,
  }),
  createRoute({
    getParentRoute: () => appRoute,
    path: '/finance/accounts',
    component: AccountsPage,
  }),
  createRoute({
    getParentRoute: () => appRoute,
    path: '/finance/accounts/$accountId',
    component: StatementPage,
  }),
  createRoute({
    getParentRoute: () => appRoute,
    path: '/finance/reports',
    validateSearch: (search: Record<string, unknown>): { tab: ReportTab } => ({
      tab: (['income', 'trial', 'balance', 'book'] as const).includes(search.tab as ReportTab)
        ? (search.tab as ReportTab)
        : 'income',
    }),
    component: FinanceReportsPage,
  }),
  createRoute({ getParentRoute: () => appRoute, path: '/finance/close', component: ClosePage }),
  // Payroll (ADR-015)
  createRoute({ getParentRoute: () => appRoute, path: '/finance/payroll', component: PayrollPage }),
  createRoute({
    getParentRoute: () => appRoute,
    path: '/finance/payroll/$runId',
    component: PayrollRunPage,
  }),
  createRoute({
    getParentRoute: () => appRoute,
    path: '/finance/employees/$employeeId',
    component: EmployeePage,
  }),
  // Point of sale (ADR-014)
  createRoute({ getParentRoute: () => appRoute, path: '/pos', component: PosPage }),
  createRoute({
    getParentRoute: () => appRoute,
    path: '/pos/receipts/$saleId',
    // print=true: straight from the till, the receipt prints at once.
    validateSearch: (search: Record<string, unknown>): { print: boolean } => ({
      print: search.print === true || search.print === 'true',
    }),
    component: ReceiptPage,
  }),
  createRoute({ getParentRoute: () => appRoute, path: '/pos/shifts', component: PosShiftsPage }),
  createRoute({
    getParentRoute: () => appRoute,
    path: '/pos/shifts/$shiftId',
    component: PosShiftPage,
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

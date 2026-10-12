import { ToastProvider } from '@althobe/ui/components';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError } from './api';
import { createAppRouter } from './router';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    // Business refusals (4xx) are answers, not network blips: never retry them.
    queries: {
      // Each request crosses the internet (~0.5 s from Syria); a page opened again within 30 s
      // shows what it has without asking. Every save refreshes what it changed regardless.
      staleTime: 30_000,
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    },
  },
});
const router = createAppRouter(queryClient);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);

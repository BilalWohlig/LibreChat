import React, { useMemo, useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { QueryKeys, request } from 'librechat-data-provider';
import DataTable from '~/components/ui/DataTable';
import { Button } from '~/components/ui/Button';
import { SearchBar } from '~/views/admin/AdminSearchBar';
import { UserActions } from '~/views/admin/UserActions';
import { UserUsageDialog } from '~/views/admin/UserUsageDialog';
import { ArrowLeft } from 'lucide-react';
import { Pagination } from '~/components/ui/Pagination';

type AdminUser = {
  _id: string;
  email?: string;
  username?: string;
  name?: string;
  role?: string;
  createdAt?: string;
  totalCost?: number;
};

export default function AdminDashboard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const mainContainerRef = useRef<HTMLDivElement>(null);

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [limit] = useState(10); // Show 10 users per page
  const [selectedUser, setSelectedUser] = useState<AdminUser | null>(null);
  const [usageOpen, setUsageOpen] = useState(false);

  const handleGoBack = () => {
    const previousPage = sessionStorage.getItem('previousPage');
    if (previousPage) {
      navigate(previousPage);
      return;
    }

    try {
      const raw = localStorage.getItem('LAST_CONVO_SETUP_0');
      if (raw) {
        const parsed = JSON.parse(raw);
        const convoId = parsed?.conversationId;
        if (convoId && convoId !== 'new') {
          navigate(`/c/${convoId}`);
          return;
        }
      }
    } catch (_) {}

    navigate('/c/new');
  };

  // Fetch Users
  const usersQuery = useQuery({
    queryKey: [QueryKeys.roles, 'admin', 'users', { page, limit, search }],
    queryFn: async () => {
      const q = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (search) q.set('search', search);
      return await request.get(`/api/admin/users?${q.toString()}`);
    },
    keepPreviousData: true,
    refetchOnWindowFocus: false,
    onSuccess: () => {
      const totalPages = Math.ceil((usersQuery.data as any)?.total / limit) || 1;
      if (page > totalPages && page !== 1) {
        setPage(1);
      }
    },
  });

  // Fetch Total Expenditure across all users
  const totalExpenditureQuery = useQuery({
    queryKey: [QueryKeys.roles, 'admin', 'total-expenditure'],
    queryFn: async () => await request.get('/api/admin/total-expenditure'),
    refetchInterval: 30000, // Refetch every 30 seconds for real-time updates
    refetchOnWindowFocus: true,
  });

  // Mutations
  const updateRoleMutation = useMutation({
    mutationFn: async ({ id, nextRole }: { id: string; nextRole: string }) =>
      await request.put(`/api/admin/users/${id}/role`, { role: nextRole }),
    onSuccess: () => queryClient.invalidateQueries([QueryKeys.roles, 'admin', 'users']),
  });

  const deleteUserMutation = useMutation({
    mutationFn: async (id: string) => await request.delete(`/api/admin/users/${id}`),
    onSuccess: () => queryClient.invalidateQueries([QueryKeys.roles, 'admin', 'users']),
  });

  const data = ((usersQuery.data as any)?.users ?? []) as AdminUser[];
  const total = (usersQuery.data as any)?.total ?? 0;
  
  // Get total expenditure from API (across all users, not just current page)
  const totalExpenditure = (totalExpenditureQuery.data as any)?.totalExpenditure ?? 0;

  // Adjust table height
  useEffect(() => {
  const adjustTableHeight = () => {
    if (mainContainerRef.current) {
      const rowHeight = 48; // same as CSS row height
      const headerHeight = 48; // optional table header height, adjust if needed
      const totalRows = limit; // 10 records per page
      const paginationHeight = 60; // height of pagination component
      const containerHeight = rowHeight * totalRows + headerHeight + paginationHeight;
      mainContainerRef.current.style.height = `${containerHeight}px`;
    }
  };

  adjustTableHeight();
  window.addEventListener('resize', adjustTableHeight);
  return () => window.removeEventListener('resize', adjustTableHeight);
}, [limit]);


  // Columns for DataTable
  const columns = useMemo(
    () => [
      {
        id: 'index',
        header: 'No.',
        meta: { size: '60px' },
        cell: ({ row }: any) => (
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
            {(page - 1) * limit + row.index + 1}
          </span>
        ),
      },
      {
        accessorKey: 'email',
        header: 'Email',
        cell: ({ row }: any) => (
          <span className="text-sm text-gray-900 dark:text-gray-100">
            {row.original.email ?? '—'}
          </span>
        ),
        meta: { size: '220px' },
      },
      {
        accessorKey: 'name',
        header: 'Name',
        cell: ({ row }: any) => (
          <span className="text-sm text-gray-900 dark:text-gray-100">
            {row.original.name ?? '—'}
          </span>
        ),
        meta: { size: '180px' },
      },
      {
        accessorKey: 'totalCost',
        header: 'Total Cost (USD)',
        cell: ({ row }: any) => {
          const totalCost = row.original.totalCost || 0;
          return (
            <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
              ${Math.abs(totalCost / 1000000).toFixed(2)}
            </span>
          );
        },
        meta: { size: '140px' },
      },
      {
        accessorKey: 'role',
        header: 'Role',
        meta: { size: '120px' },
        cell: ({ row }: any) => {
          const role = row.original.role;
          const normalizedRole = String(role).trim();
          const isAdmin = normalizedRole.toLowerCase() === 'admin';
          const isUser = normalizedRole.toLowerCase() === 'user';

          return (
            <span
              className={[
                'inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium',
                isAdmin
                  ? 'bg-green-100 !text-green-700 dark:bg-green-900 dark:!text-green-300'
                  : isUser
                  ? 'bg-blue-100 !text-blue-700 dark:bg-blue-900 dark:!text-blue-300'
                  : 'bg-slate-100 !text-slate-700 dark:bg-slate-800 dark:!text-slate-300',
              ].join(' ')}
            >
              {role}
            </span>
          );
        },
      },
      {
        accessorKey: 'createdAt',
        header: 'Created',
        meta: { size: '150px' },
        cell: ({ row }: any) => (
          <span className="text-xs text-gray-900 dark:text-gray-100">
            {row.original.createdAt ? new Date(row.original.createdAt).toLocaleDateString() : '—'}
          </span>
        ),
      },
      {
        id: 'actions',
        header: 'Actions',
        meta: { size: '200px' },
        cell: ({ row }: any) => {
          const user: AdminUser = row.original;
          return (
            <UserActions
              user={user}
              onToggleRole={(id, nextRole) => updateRoleMutation.mutate({ id, nextRole })}
              onView={(u) => {
                setSelectedUser(u);
                setUsageOpen(true);
              }}
              onDelete={(id) => deleteUserMutation.mutate(id)}
            />
          );
        },
      },
    ],
    [page, limit, updateRoleMutation, deleteUserMutation],
  );

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <style>
  {`
    /* Container disables scrolling */
    .no-scroll-table,
    .no-scroll-table > div,
    .no-scroll-table .data-table-container,
    .no-scroll-table .data-table-container > div {
      overflow: hidden !important;
      max-height: none !important;
    }

    /* Table retains native layout for proper column alignment */
    .no-scroll-table table {
      display: table !important;
      width: 100% !important;
      table-layout: fixed !important;
      border-collapse: collapse;
    }

    /* Table body shows all rows, no scroll */
    .no-scroll-table tbody {
      display: table-row-group !important;
      overflow: hidden !important;
      max-height: none !important;
    }

    /* Rows have fixed height */
    .no-scroll-table tr {
      display: table-row !important<th class="h-12 align-middle whitespace-nowrap bg-surface-secondary px-2 py-2 text-left text-sm font-medium text-text-secondary sm:px-4" style="width: 140px; max-width: 140px;">Total Cost (USD)</th>
      height: 48px ; /* Adjust row height */
    }

    /* Cells aligned properly */
    .no-scroll-table td {
      display: table-cell !important;
      height: 48px !important;
      vertical-align: middle;
      overflow: hidden;
      padding: 0 8px; /* Optional: adjust spacing */
    }
  `}
</style>

      {/* Header */}
      <div className="mb-3 flex items-center justify-between border-b border-gray-200 dark:border-gray-700 pb-3">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleGoBack}
            className="rounded-full"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">User Management</h2>
        </div>
        <div className="flex items-center gap-2 rounded-lg border-2 border-blue-500 bg-blue-50 px-4 py-2 shadow-lg dark:border-blue-400 dark:bg-blue-900/20">
          <span className="text-sm font-medium text-blue-600 dark:text-blue-400">Total Expenditure:</span>
          <span className="text-lg font-bold text-blue-900 dark:text-blue-100">
            {totalExpenditureQuery.isLoading ? (
              <span className="text-sm">Loading...</span>
            ) : (
              `$${Math.abs(totalExpenditure / 1000000).toFixed(2)}`
            )}
          </span>
        </div>
      </div>

      {/* Search */}
      <SearchBar
        search={search}
        setSearch={(value) => {
          setSearch(value);
          setPage(1);
        }}
      />

      {/* Table with Loading Overlay */}
      <div ref={mainContainerRef} className="relative flex-1 min-h-0 no-scroll-table">
        {usersQuery.isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-white bg-opacity-50 dark:bg-gray-800 dark:bg-opacity-50 z-10">
            <svg className="animate-spin h-5 w-5 text-gray-500" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            </svg>
            <p className="ml-2 text-gray-500 dark:text-gray-400">Loading...</p>
          </div>
        )}
        <div className="h-full data-table-container">
          <DataTable
            columns={columns as any}
            data={data.slice(0, limit).map((r, i) => ({ ...r, id: r._id || i }))}
            className="h-full"
            enableRowSelection={false}
            showCheckboxes={false}
            onDelete={undefined}
          />
        </div>
      </div>
      {data.length === 0 && !usersQuery.isLoading && (
        <div className="flex h-40 w-full items-center justify-center">
          <p className="text-gray-500 dark:text-gray-400">No matching users found</p>
        </div>
      )}

      {/* Pagination */}
      {total > 0 && (
        <div data-testid="pagination-container" className="flex-shrink-0">
          <Pagination
            page={page}
            limit={limit}
            total={total}
            onPageChange={setPage}
            siblingCount={1}
          />
        </div>
      )}

      {/* Usage Dialog */}
      <UserUsageDialog
        open={usageOpen}
        onOpenChange={setUsageOpen}
        user={selectedUser}
        invalidate={(from?: string, to?: string) =>
          selectedUser &&
          queryClient.invalidateQueries({
            queryKey: [QueryKeys.roles, 'admin', 'usage', selectedUser._id, from, to],
          })
        }
      />
    </div>
  );
}
import {
  Alert,
  Button,
  Card,
  Code,
  Field,
  Input,
  PageTitle,
  useToast,
} from '@althobe/ui/components';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, type Location } from '../api';
import { errorText, LOCATION_KIND } from '../format';
import { PAGES } from '../help';
import { locationsQuery } from '../queries';

/** Owner only (the API enforces admin.locations.write): the names of the warehouses and store. */
export function LocationsPage() {
  const { data: locations = [] } = useQuery(locationsQuery);
  return (
    <>
      <PageTitle intro={PAGES.locations}>المواقع</PageTitle>
      <div className="grid gap-4 md:grid-cols-2">
        {locations.map((l) => (
          <LocationCard key={l.id} location={l} />
        ))}
      </div>
    </>
  );
}

function LocationCard({ location }: { location: Location }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [nameAr, setNameAr] = useState(location.nameAr);
  const [nameEn, setNameEn] = useState(location.nameEn ?? '');
  const changed = nameAr.trim() !== location.nameAr || nameEn.trim() !== (location.nameEn ?? '');

  const save = useMutation({
    mutationFn: async () =>
      api.updateLocation(location.id, { nameAr: nameAr.trim(), nameEn: nameEn.trim() || null }),
    onSuccess: async (saved) => {
      toast(`تم حفظ الاسم «${saved.nameAr}» — يظهر الآن في كل الصفحات والسجل`);
      await queryClient.invalidateQueries({ queryKey: locationsQuery.queryKey });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (changed && nameAr.trim()) save.mutate();
  };

  return (
    <Card>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-ink-muted">{LOCATION_KIND[location.kind]}</span>
          <Code>{location.code}</Code>
        </div>
        <Field label="الاسم">
          <Input required value={nameAr} onChange={(e) => setNameAr(e.target.value)} />
        </Field>
        <Field label="الاسم بالإنجليزية (اختياري)">
          <Input dir="ltr" value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
        </Field>
        <div>
          <Button type="submit" disabled={!changed || !nameAr.trim() || save.isPending}>
            حفظ
          </Button>
        </div>
        {save.isError && <Alert>{errorText(save.error)}</Alert>}
      </form>
    </Card>
  );
}

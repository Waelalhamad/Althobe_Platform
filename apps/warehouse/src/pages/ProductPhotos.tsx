import { Alert, Button, Card, Chip, ConfirmButton } from '@althobe/ui/components';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, type OptionGroup, type Photo } from '../api';
import { errorText, valueLabel } from '../format';
import { photoSrc, shrinkPhoto } from '../photo';
import { modeQuery, photosQuery } from '../queries';

/**
 * The product's photos (ADR-010). A photo can be tagged with the option values it shows
 * (e.g. رسمي + كحلي); every variant then shows the photo that matches it best.
 */
export function ProductPhotos({
  productId,
  groups,
  canWrite,
}: {
  productId: string;
  groups: OptionGroup[];
  canWrite: boolean;
}) {
  const { data: mode } = useQuery(modeQuery);
  const { data: photos = [] } = useQuery(photosQuery(productId));
  const [selected, setSelected] = useState<string | null>(null);
  const selectedPhoto = photos.find((p) => p.id === selected);

  if (!mode?.photos) {
    return canWrite ? (
      <Card className="mt-4">
        <p className="text-ink-muted">الصور غير مفعّلة على هذا الخادم (إعدادات S3 غير موجودة).</p>
      </Card>
    ) : null;
  }
  if (!canWrite && photos.length === 0) return null;

  return (
    <Card className="mt-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-bold">الصور</h2>
        {canWrite && <Uploader productId={productId} />}
      </div>
      {canWrite && photos.length > 0 && (
        <p className="mb-3 text-sm text-ink-muted">
          اضغط على صورة لتحديد ما تُظهره (مثلاً رسمي + كحلي): كل صنف يعرض الصورة الأقرب له. الصورة
          الأولى هي الصورة الرئيسية للمنتج.
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        {photos.map((p, i) => (
          <button
            key={p.id}
            type="button"
            onClick={() =>
              canWrite
                ? setSelected(p.id === selected ? null : p.id)
                : window.open(photoSrc(p.id, 'full'), '_blank')
            }
            className={`relative overflow-hidden rounded-lg border-2 ${p.id === selected ? 'border-brand' : 'border-transparent'}`}
          >
            <img
              src={photoSrc(p.id)}
              alt=""
              loading="lazy"
              className="size-28 bg-blush object-cover"
            />
            {i === 0 && (
              <span className="absolute start-1 top-1 rounded bg-brand px-1.5 text-xs text-white">
                رئيسية
              </span>
            )}
            {p.valueIds.length > 0 && (
              <span className="absolute inset-x-0 bottom-0 truncate bg-black/60 px-1 text-xs text-white">
                {tagNames(p, groups)}
              </span>
            )}
          </button>
        ))}
        {photos.length === 0 && <p className="text-ink-muted">لا توجد صور بعد</p>}
      </div>
      {canWrite && selectedPhoto && (
        <PhotoEditor
          key={selectedPhoto.id}
          productId={productId}
          photo={selectedPhoto}
          groups={groups}
          first={photos[0]?.id === selectedPhoto.id}
          last={photos.at(-1)?.id === selectedPhoto.id}
          onDeleted={() => setSelected(null)}
        />
      )}
    </Card>
  );
}

const tagNames = (photo: Photo, groups: OptionGroup[]) =>
  groups
    .flatMap((g) =>
      g.values.filter((v) => photo.valueIds.includes(v.id)).map((v) => valueLabel(g, v)),
    )
    .join(' · ');

/** Several photos at once, from the gallery or the phone camera; shrunk, then sent one by one. */
function Uploader({ productId }: { productId: string }) {
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      setProgress({ done: 0, total: files.length });
      for (const [i, file] of files.entries()) {
        let photo;
        try {
          photo = await shrinkPhoto(file);
        } catch {
          throw new Error(`تعذّر قراءة الصورة «${file.name}» — جرّب صورة JPEG`);
        }
        await api.uploadPhoto(productId, photo);
        setProgress({ done: i + 1, total: files.length });
        await queryClient.invalidateQueries({ queryKey: ['photos', productId] });
      }
    },
    onSettled: async () => {
      setProgress(null);
      if (input.current) input.current.value = '';
      // The main photo and each variant's photo may have changed.
      await queryClient.invalidateQueries({ queryKey: ['variants', productId] });
      await queryClient.invalidateQueries({ queryKey: ['products'] });
    },
  });

  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          if (files.length) upload.mutate(files);
        }}
      />
      <Button
        variant="secondary"
        disabled={upload.isPending}
        onClick={() => input.current?.click()}
      >
        {progress ? `جارٍ رفع ${progress.done + 1} من ${progress.total}…` : 'إضافة صور'}
      </Button>
      {upload.isError && (
        <span className="text-sm text-bad">
          {upload.error instanceof Error && !('code' in upload.error)
            ? upload.error.message
            : errorText(upload.error)}
        </span>
      )}
    </>
  );
}

function PhotoEditor({
  productId,
  photo,
  groups,
  first,
  last,
  onDeleted,
}: {
  productId: string;
  photo: Photo;
  groups: OptionGroup[];
  first: boolean;
  last: boolean;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['photos', productId] });
    await queryClient.invalidateQueries({ queryKey: ['variants', productId] });
    await queryClient.invalidateQueries({ queryKey: ['products'] });
  };

  const update = useMutation({
    mutationFn: async (patch: Parameters<typeof api.updatePhoto>[1]) =>
      api.updatePhoto(photo.id, patch),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: async () => api.deletePhoto(photo.id),
    onSuccess: async () => {
      onDeleted();
      await refresh();
    },
  });

  const toggleTag = (valueId: string) =>
    update.mutate({
      valueIds: photo.valueIds.includes(valueId)
        ? photo.valueIds.filter((id) => id !== valueId)
        : [...photo.valueIds, valueId],
    });

  return (
    <div className="mt-4 grid gap-4 rounded-lg bg-blush p-3 md:grid-cols-[12rem_1fr]">
      <a href={photoSrc(photo.id, 'full')} target="_blank" rel="noreferrer">
        <img
          src={photoSrc(photo.id)}
          alt=""
          className="aspect-square w-48 rounded-lg bg-white object-cover"
        />
      </a>
      <div className="flex flex-col gap-3">
        <span className="font-medium">ماذا تُظهر هذه الصورة؟ (اختياري)</span>
        {groups.map((g) => (
          <div key={g.id} className="flex flex-wrap items-center gap-2">
            <span className="w-24 text-sm text-ink-muted">{g.nameAr}</span>
            {g.values
              .filter((v) => v.isActive || photo.valueIds.includes(v.id))
              .map((v) => (
                <Chip
                  key={v.id}
                  selected={photo.valueIds.includes(v.id)}
                  disabled={update.isPending}
                  onClick={() => toggleTag(v.id)}
                >
                  {valueLabel(g, v)}
                </Chip>
              ))}
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            disabled={first || update.isPending}
            onClick={() => update.mutate({ move: 'first' })}
          >
            اجعلها الرئيسية
          </Button>
          <Button
            variant="secondary"
            aria-label="تقديم"
            disabled={first || update.isPending}
            onClick={() => update.mutate({ move: 'up' })}
          >
            ▶
          </Button>
          <Button
            variant="secondary"
            aria-label="تأخير"
            disabled={last || update.isPending}
            onClick={() => update.mutate({ move: 'down' })}
          >
            ◀
          </Button>
          <span className="ms-auto">
            <ConfirmButton
              variant="danger"
              disabled={remove.isPending}
              onConfirm={() => remove.mutate()}
            >
              حذف الصورة
            </ConfirmButton>
          </span>
        </div>
        {(update.isError || remove.isError) && (
          <Alert>{errorText(update.error ?? remove.error)}</Alert>
        )}
      </div>
    </div>
  );
}

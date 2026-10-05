import { Alert, Button, Card, ConfirmButton } from '@althobe/ui/components';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, type Photo } from '../api';
import { errorText } from '../format';
import { photoSrc, shrinkPhoto } from '../photo';
import { modeQuery, photosQuery } from '../queries';
import { useCatalogueRefresh } from './catalogue-parts';

/** The product's photos (ADR-010, ADR-011): one design's photos; the first is the main one. */
export function ProductPhotos({ productId, canWrite }: { productId: string; canWrite: boolean }) {
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
          الصورة الأولى هي الصورة الرئيسية للمنتج. اضغط على صورة لترتيبها أو حذفها.
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
          </button>
        ))}
        {photos.length === 0 && <p className="text-ink-muted">لا توجد صور بعد</p>}
      </div>
      {canWrite && selectedPhoto && (
        <PhotoEditor
          key={selectedPhoto.id}
          photo={selectedPhoto}
          first={photos[0]?.id === selectedPhoto.id}
          last={photos.at(-1)?.id === selectedPhoto.id}
          onDeleted={() => setSelected(null)}
        />
      )}
    </Card>
  );
}

/** Several photos at once, from the gallery or the phone camera; shrunk, then sent one by one. */
function Uploader({ productId }: { productId: string }) {
  const queryClient = useQueryClient();
  const refresh = useCatalogueRefresh();
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
      // The main photo may have changed.
      await refresh();
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
  photo,
  first,
  last,
  onDeleted,
}: {
  photo: Photo;
  first: boolean;
  last: boolean;
  onDeleted: () => void;
}) {
  const refresh = useCatalogueRefresh();

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

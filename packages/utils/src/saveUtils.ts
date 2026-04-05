type SaveAction<T> = () => Promise<T | null>;

export type SaveWithFallbackResult<T> = {
  result: T | null;
  error: string | null;
};

const toErrorMessage = (error: unknown) => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  return "Opslaan is mislukt.";
};

export const saveWithFallback = async <T>(options: {
  save: SaveAction<T>;
  saveAs: SaveAction<T>;
}): Promise<SaveWithFallbackResult<T>> => {
  try {
    return { result: await options.save(), error: null };
  } catch {
    try {
      return { result: await options.saveAs(), error: null };
    } catch (error) {
      return { result: null, error: toErrorMessage(error) };
    }
  }
};

export const runAction = async <T>(action: SaveAction<T>): Promise<SaveWithFallbackResult<T>> => {
  try {
    return { result: await action(), error: null };
  } catch (error) {
    return { result: null, error: toErrorMessage(error) };
  }
};

import type { SearchResult } from "../search/searchClient";
import type { Locale } from "../i18n";
import { translate } from "../i18n";
import styles from "./MilestonePanels.module.css";

interface SearchResultsProps {
  results: SearchResult[];
  locale: Locale;
  onOpen: (path: string) => void;
}

/**
 * Renders contextual full-text results in place of the file tree.
 * @param props Results, locale, and open callback.
 * @returns Accessible local search results.
 */
export function SearchResults({ results, locale, onOpen }: SearchResultsProps) {
  if (results.length === 0) return <p className={styles.empty}>{translate(locale, "noResults")}</p>;
  return (
    <ul className={styles.results} aria-label={translate(locale, "results")}>
      {results.map((result) => (
        <li key={result.path}>
          <button type="button" onClick={() => onOpen(result.path)}>
            <strong>{result.path}</strong>
            <span>{result.snippet}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

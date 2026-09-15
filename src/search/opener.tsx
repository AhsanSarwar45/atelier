/**
 * Opening the search from anywhere under the project screen (bw-21a2.7).
 *
 * The screen holds whether the search is open and which tab's search it is;
 * a tab's own controls — the board's search button, its `/` key — only ask
 * for it to open.
 */
'use client';

import { createContext, useContext } from 'react';

const OpenSearch = createContext<() => void>(() => undefined);

export const SearchOpener = OpenSearch.Provider;

/** Opens the showing tab's search. */
export const useOpenSearch = () => useContext(OpenSearch);

/** An illustrative asset-to-ownership diagram, with no simulated market data. */
export function OwnershipVisual() {
  return (
    <svg viewBox="0 0 560 500" fill="none" role="img" aria-labelledby="ownership-title ownership-description">
      <title id="ownership-title">From real-world assets to digital ownership</title>
      <desc id="ownership-description">An architectural asset connects through documented rights to tokens on Solana. A conceptual illustration of the asset lifecycle.</desc>
      <defs>
        <linearGradient id="ownership-ground" x1="280" y1="180" x2="280" y2="480" gradientUnits="userSpaceOnUse"><stop stopColor="#6CA67F" stopOpacity=".12" /><stop offset="1" stopColor="#6CA67F" stopOpacity="0" /></linearGradient>
        <linearGradient id="ownership-front" x1="120" y1="185" x2="200" y2="370" gradientUnits="userSpaceOnUse"><stop stopColor="#DCE8DD" /><stop offset="1" stopColor="#95B6A0" /></linearGradient>
        <linearGradient id="ownership-coin" x1="370" y1="205" x2="450" y2="310" gradientUnits="userSpaceOnUse"><stop stopColor="#C2E2A3" /><stop offset="1" stopColor="#6CA67F" /></linearGradient>
      </defs>

      <circle cx="285" cy="248" r="204" stroke="#C3DDC5" strokeOpacity=".10" />
      <circle cx="285" cy="248" r="151" stroke="#C3DDC5" strokeOpacity=".08" strokeDasharray="3 9" />
      <path d="m25 330 255-147 255 147-255 147Z" fill="url(#ownership-ground)" stroke="#6CA67F" strokeOpacity=".16" />
      {[0, 1, 2, 3, 4].map((i) => <g key={i} stroke="#6CA67F" strokeOpacity=".10"><path d={`M${67 + i * 42} ${306 - i * 24}l255 147`} /><path d={`M${67 + i * 42} ${354 + i * 24}l255-147`} /></g>)}

      <path d="M172 153c48-99 191-112 250-17" stroke="#9AC8A4" strokeOpacity=".55" strokeDasharray="4 7" />
      <path d="m411 133 12 7 1-14" stroke="#9AC8A4" strokeWidth="1.5" />
      <circle cx="172" cy="153" r="4" fill="#B8D6A7" />

      <g transform="translate(207 51)">
        <rect width="147" height="42" rx="21" fill="#1C3E2F" stroke="#4C6C55" />
        <path d="M19 12h10l5 5v13H19zM29 12v6h5M23 23h7M23 26h5" stroke="#C3DDC5" strokeWidth="1.2" strokeLinejoin="round" />
        <text x="45" y="25" fill="#D9E7D9" fontFamily="var(--font-geist-sans), sans-serif" fontSize="11">Documented rights</text>
      </g>

      <g>
        <path d="m61 339 110-64 130 75-110 64Z" fill="#294C3A" stroke="#7FA18B" strokeOpacity=".45" />
        <path d="M61 339v10l130 75v-10Z" fill="#284534" /><path d="m191 414 110-64v10l-110 64Z" fill="#1B392A" />
        <path d="m90 260 54-31 54 31-54 31Z" fill="#EDF2E8" />
        <path d="M90 260v80l54 31v-80Z" fill="url(#ownership-front)" />
        <path d="m144 291 54-31v80l-54 31Z" fill="#6C927A" />
        <path d="m150 175 61-35 61 35-61 35Z" fill="#EDF2E8" />
        <path d="M150 175v170l61 35V210Z" fill="url(#ownership-front)" />
        <path d="m211 210 61-35v170l-61 35Z" fill="#6C927A" />
        <path d="m164 174 47-27 47 27-47 27Z" stroke="#ACBCAC" />
        {[0, 1, 2, 3, 4, 5].map((i) => <g key={i} stroke="#3A6450" strokeWidth="5"><path d={`M163 ${201 + i * 23}l12 7m9 5 12 7`} /><path d={`M224 ${220 + i * 23}l12-7m9-5 12-7`} /></g>)}
        {[0, 1, 2].map((i) => <path key={i} d={`M101 ${282 + i * 24}l12 7m9 5 11 6`} stroke="#527A61" strokeWidth="5" />)}
        <path d="m198 373 13 7 13-7v-24l-13 7-13-7Z" fill="#305B44" />
      </g>

      <path d="m291 327 47-27" stroke="#B8D6A7" strokeWidth="1.5" strokeDasharray="4 5" /><path d="m328 297 12 2-4 11" stroke="#B8D6A7" strokeWidth="1.5" />
      <g>
        <path d="m331 320 80-46 91 52-80 47Z" fill="#30543B" stroke="#81AA7A" strokeOpacity=".6" />
        <path d="M331 320v12l91 53v-12Z" fill="#2B4936" /><path d="m422 373 80-47v12l-80 47Z" fill="#203D2B" />
        {[0, 1, 2].map((i) => <g key={i} transform={`translate(0 ${-i * 22})`}><path d="M366 291v13c0 16 22 28 49 28s49-12 49-28v-13" fill="url(#ownership-coin)" stroke="#85AC76" /><ellipse cx="415" cy="291" rx="49" ry="28" fill="#BDDAA5" stroke="#D5E9C6" /><ellipse cx="415" cy="291" rx="37" ry="20" stroke="#799A65" strokeOpacity=".65" /></g>)}
        <path d="m396 249 15-8 9 5-15 9Zm16 9 15-8 9 5-15 9Zm-1-18 9-5 16 9-9 5Z" fill="#3D6544" />
      </g>

      <g fill="#C3DDC5" fontFamily="var(--font-geist-mono), monospace" fontSize="10" letterSpacing="1.4"><text x="82" y="458">THE ASSET</text><text x="354" y="416">THE OWNERSHIP</text></g>
      <path d="M123 432v-16m293-14v-14" stroke="#86AC8A" strokeOpacity=".65" />
      <g transform="translate(356 150)"><rect width="122" height="29" rx="14.5" stroke="#648666" /><circle cx="16" cy="14.5" r="3" fill="#BDDAA5" /><text x="28" y="18" fill="#D9E7D9" fontFamily="var(--font-geist-mono), monospace" fontSize="9" letterSpacing="1.5">ON SOLANA</text></g>
      <path d="M482 214h12m-6-6v12M80 180h8m-4-4v8" stroke="#A3C092" strokeOpacity=".6" />
    </svg>
  );
}

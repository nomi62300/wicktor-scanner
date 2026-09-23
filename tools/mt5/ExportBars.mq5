//+------------------------------------------------------------------+
//|  ExportBars.mq5                                                   |
//|  Wicktor — export MT5 bars + broker specs for tools/orb-backtest  |
//|                                                                   |
//|  BROKER-AGNOSTIC BY DESIGN. It takes the symbol from the chart it |
//|  is attached to, so it works on Exness, IC Markets, Pepperstone,  |
//|  whatever — there is no need to move accounts to run the backtest,|
//|  and you SHOULD NOT: the whole value of the spread column is that |
//|  it is YOUR broker's spread, on the account you would actually    |
//|  trade. A backtest on someone else's feed answers a different     |
//|  question.                                                        |
//|                                                                   |
//|  HOW TO USE                                                       |
//|   1. MetaEditor -> open this file -> Compile (F7).                |
//|   2. In MT5, open a chart of the index you want (UK100, UK100m,   |
//|      FTSE100 — whatever your broker calls it).                    |
//|   3. Scroll the chart back as far as you want history, or just    |
//|      let the script pull it (it waits for the server sync).       |
//|   4. Drag "ExportBars" from the Navigator onto that chart.        |
//|   5. Files land in MQL5/Files — File -> Open Data Folder.         |
//|      Copy them into the repo's data/ directory.                   |
//|                                                                   |
//|  OUTPUT (filenames start with the symbol, which is how            |
//|  orb-backtest.js infers it when --symbol is not given):           |
//|      <SYMBOL>_M1.csv    time,o,h,l,c,v,spread                     |
//|      <SYMBOL>_M5.csv        "                                     |
//|      <SYMBOL>_M15.csv       "                                     |
//|      <SYMBOL>_specs.csv symbol,point,point_value,volume_min,...   |
//|                                                                   |
//|  TIMESTAMPS ARE BROKER SERVER TIME, not UTC. That is why the      |
//|  specs file records the server name, and why orb-backtest.js      |
//|  REFUSES to run without --tz-in. Most MT5 servers run EET/EEST,   |
//|  which is itself daylight-saving-shifting, so "UTC+2" is wrong    |
//|  for half the year and "UTC+3" for the other half — give it the   |
//|  IANA name (e.g. Europe/Helsinki) and confirm with:               |
//|      node tools/orb-backtest.js --bars data/<SYMBOL>_M5.csv \     |
//|           --tz-in Europe/Helsinki --assert-open 08:00             |
//|           --validate-only                                         |
//+------------------------------------------------------------------+
#property script_show_inputs
#property strict

input int  InpMaxBars   = 200000;  // max bars per timeframe (~2 years of M5)
input bool InpExportM1  = true;    // M1 too (enables --resolve-tf m1)
input bool InpExportM15 = true;    // M15 too (cross-checks the 15M box)

//--- wait for the terminal to finish pulling history from the server.
//    Without this, a fresh chart returns a few hundred bars and the
//    export looks like a market that simply stopped trading.
bool WaitForHistory(const string sym, const ENUM_TIMEFRAMES tf)
{
   datetime times[];
   for(int attempt = 0; attempt < 100; attempt++)
   {
      if(CopyTime(sym, tf, 0, 1, times) > 0
         && (bool)SeriesInfoInteger(sym, tf, SERIES_SYNCHRONIZED))
         return true;
      Sleep(200);
   }
   return false;
}

int ExportTf(const string sym, const ENUM_TIMEFRAMES tf, const string tfName)
{
   if(!WaitForHistory(sym, tf))
      PrintFormat("WARNING: %s %s did not report synchronized; exporting what is cached.", sym, tfName);

   MqlRates r[];
   ArraySetAsSeries(r, false);                 // oldest first
   int n = CopyRates(sym, tf, 0, InpMaxBars, r);
   if(n <= 0)
   {
      PrintFormat("ERROR: CopyRates(%s,%s) failed, err=%d", sym, tfName, GetLastError());
      return 0;
   }

   string safe = sym;
   StringReplace(safe, "/", "_");
   StringReplace(safe, "\\", "_");
   string fname = safe + "_" + tfName + ".csv";

   int h = FileOpen(fname, FILE_WRITE | FILE_CSV | FILE_ANSI, ',');
   if(h == INVALID_HANDLE)
   {
      PrintFormat("ERROR: FileOpen(%s) failed, err=%d", fname, GetLastError());
      return 0;
   }

   FileWrite(h, "time", "o", "h", "l", "c", "v", "spread");
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   for(int i = 0; i < n; i++)
      FileWrite(h,
                TimeToString(r[i].time, TIME_DATE | TIME_MINUTES | TIME_SECONDS),
                DoubleToString(r[i].open,  digits),
                DoubleToString(r[i].high,  digits),
                DoubleToString(r[i].low,   digits),
                DoubleToString(r[i].close, digits),
                (long)r[i].tick_volume,
                (int)r[i].spread);
   FileClose(h);

   PrintFormat("%s: %d bars  %s .. %s  -> %s",
               tfName, n,
               TimeToString(r[0].time,     TIME_DATE | TIME_MINUTES),
               TimeToString(r[n - 1].time, TIME_DATE | TIME_MINUTES),
               fname);
   return n;
}

void OnStart()
{
   string sym = _Symbol;
   if(!SymbolSelect(sym, true))
      PrintFormat("WARNING: SymbolSelect(%s) failed, err=%d", sym, GetLastError());

   PrintFormat("=== Wicktor ExportBars ===");
   PrintFormat("symbol %s   server %s   account %I64d",
               sym, AccountInfoString(ACCOUNT_SERVER), AccountInfoInteger(ACCOUNT_LOGIN));

   int nM5 = ExportTf(sym, PERIOD_M5, "M5");
   if(InpExportM1)  ExportTf(sym, PERIOD_M1,  "M1");
   if(InpExportM15) ExportTf(sym, PERIOD_M15, "M15");

   //--- Specs. POINT SIZE CANNOT BE INFERRED from the decimals in a
   //    close price: an index printing "10734" reads as 0 decimals and
   //    yields a point 100x too large, which then inflates every spread
   //    cost by 100x and buries the result. The broker's own spec sheet
   //    is the only authority, so it is exported alongside the bars.
   string safe = sym;
   StringReplace(safe, "/", "_");
   StringReplace(safe, "\\", "_");
   int s = FileOpen(safe + "_specs.csv", FILE_WRITE | FILE_CSV | FILE_ANSI, ',');
   if(s == INVALID_HANDLE)
   {
      PrintFormat("ERROR: could not write specs, err=%d", GetLastError());
      return;
   }
   FileWrite(s, "symbol", "point", "point_value", "volume_min", "volume_step",
                "tick_size", "contract_size", "digits", "server", "currency");
   FileWrite(s, sym,
             DoubleToString(SymbolInfoDouble(sym, SYMBOL_POINT), 10),
             DoubleToString(SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE), 10),
             DoubleToString(SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN), 4),
             DoubleToString(SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP), 4),
             DoubleToString(SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE), 10),
             DoubleToString(SymbolInfoDouble(sym, SYMBOL_TRADE_CONTRACT_SIZE), 2),
             (int)SymbolInfoInteger(sym, SYMBOL_DIGITS),
             AccountInfoString(ACCOUNT_SERVER),
             SymbolInfoString(sym, SYMBOL_CURRENCY_PROFIT));
   FileClose(s);

   PrintFormat("specs -> %s_specs.csv   point=%s  tick_value=%s  vol_min=%s",
               safe,
               DoubleToString(SymbolInfoDouble(sym, SYMBOL_POINT), 10),
               DoubleToString(SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE), 5),
               DoubleToString(SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN), 4));
   PrintFormat("Done. File -> Open Data Folder -> MQL5\\Files. Copy into the repo's data/ dir.");
   if(nM5 < 5000)
      PrintFormat("NOTE: only %d M5 bars. Scroll the chart further back (or press Home) and re-run for more history.", nM5);
}
//+------------------------------------------------------------------+

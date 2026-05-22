"""Big Shark Updates - large institutional bulk/block deal activity (EOD)."""
import streamlit as st

from lib.deals import get_block_deals, get_bulk_deals
from lib.ui import disclosure, setup_page

setup_page("Big Shark Updates")
st.title("Big Shark Updates")
st.warning(
    "A true real-time feed of bulk/block deals and mutual-fund orders requires a "
    "paid market-data subscription. NSE/BSE publish these end-of-day only, so "
    "this is the latest END-OF-DAY activity (best-effort from NSE archives), not "
    "a live tick feed."
)


def show(df, label):
    if df is None or df.empty:
        st.info(f"Could not load {label} right now (NSE may be blocking "
                "programmatic access, or there are no deals yet today).")
        return
    st.success(f"{len(df)} {label} in the latest session.")
    st.dataframe(df, use_container_width=True, hide_index=True)


tab1, tab2 = st.tabs(["Bulk deals", "Block deals"])
with tab1:
    show(get_bulk_deals(), "bulk deals")
with tab2:
    show(get_block_deals(), "block deals")

disclosure()

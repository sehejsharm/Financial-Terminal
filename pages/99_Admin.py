"""Admin - Master Admin user management (create, revoke, reset, delete)."""
import streamlit as st

from lib import auth
from lib.ui import disclosure, setup_page

setup_page("Admin")
st.title("Admin - User Management")

if not auth.is_master_admin():
    st.error("This area is restricted to the Master Admin.")
    st.stop()

st.caption("Create and manage login IDs. Standard users cannot create accounts.")

# ---- Create user --------------------------------------------------------
st.subheader("Create user")
with st.form("create_user"):
    cc1, cc2, cc3 = st.columns([2, 2, 1])
    new_user = cc1.text_input("Username")
    new_pw = cc2.text_input("Password", type="password")
    role = cc3.selectbox("Role", ["user", "master_admin"], index=0)
    if st.form_submit_button("Create user", use_container_width=True):
        ok, msg = auth.create_user(new_user, new_pw, role)
        (st.success if ok else st.error)(msg)

# ---- Manage users -------------------------------------------------------
st.subheader("Accounts")
users = auth.list_users()
hdr = ('<div class="sma-row" style="font-weight:700;color:#767c88;">'
       '<span style="flex:1;">Username</span>'
       '<span style="flex:0 0 130px;">Role</span>'
       '<span style="flex:0 0 90px;">Status</span></div>')
st.markdown(hdr, unsafe_allow_html=True)

for u in users:
    name = u["username"]
    is_master = u["role"] == "master_admin"
    status = "Active" if u["active"] else "Revoked"
    color = "#1fd286" if u["active"] else "#ff4d4f"
    cols = st.columns([3, 2, 1.4, 1.4, 1.4])
    cols[0].markdown(f'**{name}**')
    cols[1].markdown("Master Admin" if is_master else "User")
    cols[2].markdown(f'<span style="color:{color}">{status}</span>',
                     unsafe_allow_html=True)
    if is_master:
        cols[3].caption("protected")
        continue
    if u["active"]:
        if cols[3].button("Revoke", key=f"rev_{name}", use_container_width=True):
            auth.set_active(name, False)
            st.rerun()
    else:
        if cols[3].button("Activate", key=f"act_{name}", use_container_width=True):
            auth.set_active(name, True)
            st.rerun()
    if cols[4].button("Delete", key=f"del_{name}", use_container_width=True):
        auth.delete_user(name)
        st.rerun()

# ---- Reset password -----------------------------------------------------
st.subheader("Reset a password")
with st.form("reset_pw"):
    rc1, rc2 = st.columns([2, 2])
    target = rc1.selectbox("User", [u["username"] for u in users])
    newpw = rc2.text_input("New password", type="password")
    if st.form_submit_button("Reset password"):
        ok, msg = auth.reset_password((target or "").lower(), newpw)
        (st.success if ok else st.error)(msg)

disclosure()

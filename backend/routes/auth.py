"""POST /auth/login, GET /auth/me."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from backend import auth
from backend.schemas import LoginRequest, LoginResponse, MeResponse

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=LoginResponse)
def login(body: LoginRequest):
    user = auth.authenticate(body.username, body.password)
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")
    return auth.issue_token(user)


@router.get("/me", response_model=MeResponse)
def me(user: dict = Depends(auth.current_user)):
    return user

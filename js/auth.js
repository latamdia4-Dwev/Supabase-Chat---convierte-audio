// js/auth.js
// Cuentas personales: usuario + contraseña, por encima de Supabase Auth (que
// internamente exige un email). Se genera un email interno a partir del
// username para que la persona nunca tenga que escribir uno.
//
// REQUIERE la tabla "profiles" en Supabase (ver instrucciones aparte):
//   create table profiles (
//       id uuid primary key references auth.users(id) on delete cascade,
//       username text unique not null,
//       created_at timestamptz default now()
//   );
//   alter table profiles enable row level security;
//   create policy "profiles visibles" on profiles for select using (auth.role() = 'authenticated');
//   create policy "crear propio perfil" on profiles for insert with check (auth.uid() = id);
//
// Sin esa tabla y esas políticas, registerAccount() fallará al crear el perfil.

const FAKE_EMAIL_DOMAIN = '@chatapp-users.com';

function usernameToEmail(username) {
    return username.trim().toLowerCase().replace(/\s+/g, '_') + FAKE_EMAIL_DOMAIN;
}

// Crea la cuenta en Supabase Auth + su fila en "profiles" con el username real.
async function registerAccount(username, password) {
    if (!username || username.trim().length < 3) {
        throw new Error('El usuario debe tener al menos 3 caracteres.');
    }
    if (!password || password.length < 6) {
        throw new Error('La contraseña debe tener al menos 6 caracteres.');
    }

    const email = usernameToEmail(username);
    const { data, error } = await supabaseClient.auth.signUp({ email, password });
    if (error) {
        if (error.message && error.message.toLowerCase().includes('already registered')) {
            throw new Error('Ese usuario ya existe.');
        }
        throw error;
    }
    if (!data.user) throw new Error('No se pudo crear la cuenta.');

    const { error: profileError } = await supabaseClient
        .from('profiles')
        .insert([{ id: data.user.id, username: username.trim() }]);

    if (profileError) {
        if (profileError.code === '23505') throw new Error('Ese usuario ya existe.');
        throw profileError;
    }

    return data.user;
}

// Login con usuario+contraseña personal.
async function loginAccount(username, password) {
    if (!username || !password) throw new Error('Escribe tu usuario y contraseña.');
    const email = usernameToEmail(username);
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw new Error('Usuario o contraseña incorrectos.');
    return data.user;
}

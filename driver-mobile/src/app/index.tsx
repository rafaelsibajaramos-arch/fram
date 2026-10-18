import NetInfo, { NetInfoState } from '@react-native-community/netinfo';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  TextStyle,
  Text,
  TextInput,
  View,
  ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ApiError, apiRequest, login, newOperationId } from '@/lib/api';
import {
  cacheRoutes,
  cacheUser,
  clearCredentials,
  enqueueAction,
  getAccessToken,
  getCachedRoutes,
  getCachedUser,
  getRefreshToken,
  getSubjectId,
  listActions,
  QueuedAction,
  removeAction,
  retryAction,
  saveCredentials,
  saveSubjectId,
  setActionBlocked,
} from '@/lib/offline';
import { Delivery, Route, Stop } from '@/lib/types';
import { buildDeliveryOutcome } from '@/lib/workflow';

type User = { id: string; email: string; full_name: string; roles: string[] };
const COLORS = {
  background: '#f4f5ef', surface: '#ffffff', ink: '#17241e', muted: '#69766e',
  green: '#176b49', greenLight: '#e7f3eb', line: '#e1e7e1', amber: '#9a5a13',
  amberLight: '#fff3dc', red: '#a64235', redLight: '#fff0ed', blue: '#2c6174',
};

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : 'Ocurrió un error inesperado.';
}

function shortDate(value?: string) {
  if (!value) return 'Sin horario';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Sin horario' : date.toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' });
}

function quantity(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function routeLabel(status: Route['status']) {
  return ({ planned: 'Planificada', in_transit: 'En camino', completed: 'Finalizada', cancelled: 'Cancelada' } as const)[status] ?? status;
}

function deliveryFor(route: Route, stop: Stop): Delivery | undefined {
  return route.deliveries?.find((delivery) => delivery.id === stop.deliveryId);
}

function Button({ label, onPress, disabled = false, secondary = false }: {
  label: string; onPress: () => void; disabled?: boolean; secondary?: boolean;
}) {
  return (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.button, secondary && styles.buttonSecondary, disabled && styles.buttonDisabled, pressed && !disabled && styles.buttonPressed]}>
      <Text style={[styles.buttonText, secondary && styles.buttonSecondaryText]}>{label}</Text>
    </Pressable>
  );
}

function Badge({ label, tone = 'green' }: { label: string; tone?: 'green' | 'amber' | 'red' | 'blue' }) {
  const toneStyles = ({
    green: [styles.badgeGreen, styles.badgeGreenText],
    amber: [styles.badgeAmber, styles.badgeAmberText],
    red: [styles.badgeRed, styles.badgeRedText],
    blue: [styles.badgeBlue, styles.badgeBlueText],
  }[tone]) as [ViewStyle, TextStyle];
  return <View style={[styles.badge, toneStyles[0]]}><Text style={[styles.badgeText, toneStyles[1]]}>{label}</Text></View>;
}

export default function DriverHome() {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueuedAction[]>([]);
  const [online, setOnline] = useState(false);
  const [booting, setBooting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [temperatures, setTemperatures] = useState<Record<string, string>>({});
  const syncLock = useRef(false);
  const selectedRoute = routes.find((route) => route.id === selectedRouteId) ?? null;
  const pendingCount = queue.filter((action) => action.state === 'pending').length;
  const blockedCount = queue.filter((action) => action.state === 'blocked').length;

  const refreshQueue = useCallback(async (ownerId: string) => {
    setQueue(await listActions(ownerId));
  }, []);

  const loadRoutes = useCallback(async (activeUser: User, activeToken: string, allowCache = true) => {
    if (!online) {
      if (allowCache) {
        const cached = await getCachedRoutes(activeUser.id);
        if (cached) setRoutes(cached.routes as Route[]);
      }
      return;
    }
    try {
      const result = await apiRequest<Route[]>('/api/v1/routes', activeToken);
      const assigned = Array.isArray(result) ? result : [];
      setRoutes(assigned);
      await cacheRoutes(activeUser.id, assigned);
      setLastSync(new Date().toISOString());
    } catch (error) {
      if (allowCache) {
        const cached = await getCachedRoutes(activeUser.id);
        if (cached) setRoutes(cached.routes as Route[]);
      }
      throw error;
    }
  }, [online]);

  const authenticate = useCallback(async (activeToken: string, cachedUser: User | null) => {
    try {
      const me = await apiRequest<User & { sub?: string }>('/api/v1/identity/auth/me', activeToken);
      const authenticatedUser = { ...me, id: me.id ?? me.sub } as User;
      if (!authenticatedUser.id || !authenticatedUser.roles?.includes('driver')) {
        await clearCredentials();
        setToken(null);
        setUser(null);
        Alert.alert('Acceso de conductor', 'Esta cuenta no tiene el rol de conductor habilitado.');
        return;
      }
      await cacheUser(authenticatedUser);
      setUser(authenticatedUser);
      setToken(activeToken);
      await refreshQueue(authenticatedUser.id);
      if (online) await loadRoutes(authenticatedUser, activeToken).catch(() => undefined);
      else {
        const cached = await getCachedRoutes(authenticatedUser.id);
        if (cached) setRoutes(cached.routes as Route[]);
      }
    } catch (error) {
      if (!online && cachedUser?.roles?.includes('driver')) {
        setUser(cachedUser);
        setToken(activeToken);
        await refreshQueue(cachedUser.id);
        const cached = await getCachedRoutes(cachedUser.id);
        if (cached) setRoutes(cached.routes as Route[]);
        return;
      }
      await clearCredentials();
      setToken(null);
      setUser(null);
      if (online) Alert.alert('Sesión vencida', 'Inicia sesión de nuevo para sincronizar las acciones pendientes.');
    }
  }, [loadRoutes, online, refreshQueue]);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state: NetInfoState) => {
      setOnline(state.isConnected === true && state.isInternetReachable !== false);
    });
    void (async () => {
      try {
        const [savedToken, subjectId] = await Promise.all([getAccessToken(), getSubjectId()]);
        if (savedToken && subjectId) await authenticate(savedToken, await getCachedUser(subjectId));
      } finally {
        setBooting(false);
      }
    })();
    return unsubscribe;
  }, [authenticate]);

  const sync = useCallback(async () => {
    if (!online || !user || !token || syncLock.current) return;
    syncLock.current = true;
    setSyncing(true);
    try {
      const actions = await listActions(user.id);
      for (const action of actions) {
        if (action.state === 'blocked') break;
        try {
          await apiRequest(action.path, token, action.method, action.payload, action.id);
          await removeAction(action.id);
          await refreshQueue(user.id);
        } catch (error) {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
            await setActionBlocked(action.id, error.message);
            await refreshQueue(user.id);
          }
          break;
        }
      }
      await loadRoutes(user, token).catch(() => undefined);
      await refreshQueue(user.id);
      setLastSync(new Date().toISOString());
    } finally {
      syncLock.current = false;
      setSyncing(false);
    }
  }, [loadRoutes, online, refreshQueue, token, user]);

  useEffect(() => {
    if (online && user && token) void sync();
  }, [online, sync, token, user]);

  const doLogin = async () => {
    if (!loginEmail.trim() || !loginPassword) {
      Alert.alert('Completa tus datos', 'Ingresa el correo y la contraseña de tu cuenta.');
      return;
    }
    setBusy(true);
    try {
      const result = await login(loginEmail, loginPassword);
      if (!result.user.roles.includes('driver')) {
        Alert.alert('Cuenta sin acceso', 'El administrador debe asignarte el rol de conductor antes de usar esta aplicación.');
        return;
      }
      await Promise.all([
        saveCredentials(result.access_token, result.refresh_token),
        saveSubjectId(result.user.id),
        cacheUser(result.user),
      ]);
      setUser(result.user);
      setToken(result.access_token);
      setLoginPassword('');
      await refreshQueue(result.user.id);
      await loadRoutes(result.user, result.access_token).catch((error) => Alert.alert('Modo sin conexión', messageOf(error)));
    } catch (error) {
      Alert.alert('No se pudo iniciar sesión', messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  const doLogout = async () => {
    if (online && token) {
      try {
        const refreshToken = await getRefreshToken();
        if (refreshToken) await apiRequest('/api/v1/identity/auth/logout', token, 'POST', { refresh_token: refreshToken });
      } catch {
        Alert.alert('Sesión local cerrada', 'No se pudo confirmar la revocación remota. El refresh token permanecerá válido hasta su expiración.');
      }
    }
    await clearCredentials();
    setToken(null);
    setUser(null);
    setRoutes([]);
    setQueue([]);
    setSelectedRouteId(null);
  };

  const queueOperation = useCallback(async (
    method: 'PATCH' | 'POST', path: string, payload: Record<string, unknown> = {},
  ) => {
    if (!user || !token) return;
    const id = await newOperationId();
    await enqueueAction({ id, ownerId: user.id, method, path, payload });
    await refreshQueue(user.id);
    if (online) await sync();
  }, [online, refreshQueue, sync, token, user]);

  const dispatchRoute = async (route: Route) => {
    setBusy(true);
    try {
      await queueOperation('PATCH', `/api/v1/routes/${route.id}/dispatch`);
    } finally { setBusy(false); }
  };

  const arriveAt = async (route: Route, stop: Stop) => {
    setBusy(true);
    try {
      await queueOperation('PATCH', `/api/v1/routes/${route.id}/stops/${stop.id}/arrive`);
    } finally { setBusy(false); }
  };

  const closeDelivery = async (delivery: Delivery) => {
    let outcome;
    try { outcome = buildDeliveryOutcome(delivery.lots ?? [], quantities); }
    catch (error) { Alert.alert('Cantidad no válida', messageOf(error)); return; }
    setBusy(true);
    try {
      await queueOperation('PATCH', `/api/v1/deliveries/${delivery.id}/close`, outcome);
    } finally { setBusy(false); }
  };

  const recordTemperature = async (delivery: Delivery) => {
    const raw = temperatures[delivery.id];
    const value = Number(raw);
    if (!raw || !Number.isFinite(value) || value < -50 || value > 100) {
      Alert.alert('Temperatura no válida', 'Ingresa un valor entre -50 °C y 100 °C.');
      return;
    }
    setBusy(true);
    try {
      await queueOperation('POST', `/api/v1/deliveries/${delivery.id}/temperature`, {
        temperature: value,
        recordedAt: new Date().toISOString(),
        sensorEventId: `mobile-${await newOperationId()}`,
      });
      setTemperatures((current) => ({ ...current, [delivery.id]: '' }));
    } finally { setBusy(false); }
  };

  const retryBlocked = async (action: QueuedAction) => {
    await retryAction(action.id);
    await refreshQueue(action.ownerId);
    await sync();
  };

  const selectedStops = useMemo(() => selectedRoute?.stops?.slice().sort((a, b) => a.sequence - b.sequence) ?? [], [selectedRoute]);
  const pendingFor = (path: string) => queue.some((action) => action.path === path && action.state === 'pending');
  const isArrivalPending = (route: Route, stop: Stop) => pendingFor(`/api/v1/routes/${route.id}/stops/${stop.id}/arrive`);
  const canWork = (route: Route) => route.status === 'in_transit' || pendingFor(`/api/v1/routes/${route.id}/dispatch`);

  if (booting) {
    return <SafeAreaView style={styles.loading}><ActivityIndicator size="large" color={COLORS.green} /><Text style={styles.muted}>Preparando tu espacio de trabajo…</Text></SafeAreaView>;
  }

  if (!user || !token) {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="dark-content" backgroundColor={COLORS.background} />
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={styles.loginWrap} keyboardShouldPersistTaps="handled">
            <View style={styles.brandMark}><Text style={styles.brandMarkText}>F</Text></View>
            <Text style={styles.eyebrow}>FARMTOTABLE · LOGÍSTICA</Text>
            <Text style={styles.heroTitle}>Tu ruta,{ '\n' }bajo control.</Text>
            <Text style={styles.heroBody}>Accede a tus entregas, registra cada parada y continúa trabajando incluso sin conexión.</Text>
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>Ingreso de conductor</Text>
              <Text style={styles.label}>Correo electrónico</Text>
              <TextInput style={styles.input} value={loginEmail} onChangeText={setLoginEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" placeholder="tu@correo.com" placeholderTextColor="#95a098" />
              <Text style={styles.label}>Contraseña</Text>
              <TextInput style={styles.input} value={loginPassword} onChangeText={setLoginPassword} secureTextEntry autoComplete="password" placeholder="Tu contraseña" placeholderTextColor="#95a098" onSubmitEditing={() => void doLogin()} />
              <Button label={busy ? 'Validando…' : 'Entrar a mis rutas'} onPress={() => void doLogin()} disabled={busy} />
              <Text style={styles.helper}>Se requiere una cuenta activa con rol de conductor.</Text>
            </View>
            <View style={styles.networkLine}><View style={[styles.networkDot, online ? styles.dotOnline : styles.dotOffline]} /><Text style={styles.muted}>{online ? 'Gateway disponible' : 'Sin conexión · configura tu API al reconectar'}</Text></View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" backgroundColor={COLORS.background} />
      <View style={styles.topBar}>
        <View><Text style={styles.eyebrow}>FARMTOTABLE · CONDUCTOR</Text><Text style={styles.topTitle}>Hola, {user.full_name.split(' ')[0]}</Text></View>
        <Pressable style={styles.avatar} accessibilityLabel="Cerrar sesión" onPress={() => Alert.alert('Cerrar sesión', 'Las acciones guardadas se conservarán en este dispositivo.', [{ text: 'Cancelar', style: 'cancel' }, { text: 'Cerrar sesión', style: 'destructive', onPress: () => void doLogout() }])}><Text style={styles.avatarText}>{user.full_name.trim().charAt(0).toUpperCase()}</Text></Pressable>
      </View>
      <View style={[styles.connectivity, online ? styles.connectivityOnline : styles.connectivityOffline]}>
        <View style={[styles.networkDot, online ? styles.dotOnline : styles.dotOffline]} />
        <Text style={styles.connectivityText}>{online ? 'Conectado' : 'Trabajando sin conexión'}</Text>
        <View style={styles.flex} />
        {syncing ? <ActivityIndicator size="small" color={COLORS.green} /> : <Pressable onPress={() => void sync()}><Text style={styles.syncLink}>Sincronizar</Text></Pressable>}
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {!!queue.length && (
          <View style={styles.queueCard}>
            <View style={styles.queueHead}><Text style={styles.queueTitle}>Sincronización</Text><Badge label={`${queue.length} acción${queue.length === 1 ? '' : 'es'}`} tone={blockedCount ? 'red' : 'amber'} /></View>
            <Text style={styles.queueBody}>{blockedCount ? `${blockedCount} acción(es) requieren revisión. Las siguientes esperan para conservar el orden de la ruta.` : `${pendingCount} acción(es) guardadas de forma segura en este dispositivo.`}</Text>
            {queue.filter((action) => action.state === 'blocked').map((action) => (
              <View key={action.id} style={styles.blockedRow}><Text style={styles.blockedText}>{action.error || 'El servidor requiere revisar esta acción.'}</Text><Pressable onPress={() => void retryBlocked(action)}><Text style={styles.syncLink}>Reintentar</Text></Pressable></View>
            ))}
          </View>
        )}
        {selectedRoute ? (
          <>
            <Pressable style={styles.backLink} onPress={() => setSelectedRouteId(null)}><Text style={styles.backText}>‹  Todas mis rutas</Text></Pressable>
            <View style={styles.routeHero}>
              <View style={styles.routeHeroTop}><Badge label={routeLabel(selectedRoute.status)} tone={selectedRoute.status === 'completed' ? 'blue' : 'green'} /><Text style={styles.routeZone}>{selectedRoute.zone?.name ?? selectedRoute.zone?.code ?? 'Ruta asignada'}</Text></View>
              <Text style={styles.routeHeroTitle}>{selectedRoute.vehicle?.plate ? `Vehículo ${selectedRoute.vehicle.plate}` : 'Detalle de ruta'}</Text>
              <Text style={styles.routeHeroMeta}>{shortDate(selectedRoute.scheduledDate)} · {selectedStops.length} paradas</Text>
              {selectedRoute.status === 'planned' && <Button label={pendingFor(`/api/v1/routes/${selectedRoute.id}/dispatch`) ? 'Despacho guardado · pendiente' : 'Iniciar ruta'} onPress={() => void dispatchRoute(selectedRoute)} disabled={busy || pendingFor(`/api/v1/routes/${selectedRoute.id}/dispatch`)} />}
            </View>
            <Text style={styles.listHeading}>Itinerario</Text>
            {selectedStops.map((stop) => {
              const delivery = deliveryFor(selectedRoute, stop);
              const arrivePath = `/api/v1/routes/${selectedRoute.id}/stops/${stop.id}/arrive`;
              const arrivedPending = isArrivalPending(selectedRoute, stop);
              const arrived = Boolean(stop.actualAt) || arrivedPending;
              const destination = stop.type === 'pickup' ? 'Recogida en finca' : 'Entrega al comprador';
              return (
                <View key={stop.id} style={styles.stopCard}>
                  <View style={styles.stopTop}><View style={styles.sequence}><Text style={styles.sequenceText}>{String(stop.sequence).padStart(2, '0')}</Text></View><View style={styles.stopMain}><Text style={styles.stopType}>{destination}</Text><Text style={styles.stopAddress}>{stop.address}</Text><Text style={styles.stopMeta}>{shortDate(stop.plannedAt)}</Text></View><Badge label={stop.actualAt ? 'Visitada' : arrivedPending ? 'Por sincronizar' : 'Pendiente'} tone={stop.actualAt ? 'green' : arrivedPending ? 'amber' : 'blue'} /></View>
                  {delivery && stop.type === 'dropoff' && <DeliverySummary delivery={delivery} />}
                  {!stop.actualAt && !arrivedPending && canWork(selectedRoute) && <Button label={online ? 'Registrar llegada' : 'Guardar llegada sin conexión'} onPress={() => void arriveAt(selectedRoute, stop)} disabled={busy} secondary />}
                  {delivery && stop.type === 'dropoff' && arrived && ['in_transit', 'scheduled'].includes(delivery.status) && (
                    <View style={styles.closePanel}>
                      <Text style={styles.label}>Cantidad recibida por lote (kg)</Text>
                      {(delivery.lots ?? []).map((lot, index) => (
                        <View key={lot.reservationId} style={styles.quantityRow}>
                          <Text style={styles.lotLabel}>Lote {index + 1} · de {quantity(lot.quantityKg).toFixed(3)} kg</Text>
                          <TextInput style={[styles.input, styles.quantityInput]} keyboardType="decimal-pad" value={quantities[lot.reservationId] ?? String(lot.quantityKg)} onChangeText={(value) => setQuantities((current) => ({ ...current, [lot.reservationId]: value.replace(',', '.') }))} />
                        </View>
                      ))}
                      <Button label={pendingFor(`/api/v1/deliveries/${delivery.id}/close`) ? 'Entrega guardada · pendiente' : online ? 'Confirmar entrega' : 'Guardar entrega para sincronizar'} onPress={() => void closeDelivery(delivery)} disabled={busy || pendingFor(`/api/v1/deliveries/${delivery.id}/close`)} />
                    </View>
                  )}
                  {delivery?.requiresColdChain && ['in_transit', 'scheduled'].includes(delivery.status) && (
                    <View style={styles.temperatureRow}>
                      <TextInput style={[styles.input, styles.tempInput]} keyboardType="decimal-pad" value={temperatures[delivery.id] ?? ''} onChangeText={(value) => setTemperatures((current) => ({ ...current, [delivery.id]: value.replace(',', '.') }))} placeholder="Temperatura °C" placeholderTextColor="#95a098" />
                      <Button label="Registrar" onPress={() => void recordTemperature(delivery)} disabled={busy} secondary />
                    </View>
                  )}
                  {arrivedPending && <Text style={styles.helper}>La llegada aún no está confirmada por el servidor. Se enviará antes que las acciones siguientes.</Text>}
                </View>
              );
            })}
          </>
        ) : (
          <>
            <View style={styles.intro}><Text style={styles.eyebrow}>OPERACIÓN DEL DÍA</Text><Text style={styles.pageTitle}>Mis rutas</Text><Text style={styles.muted}>Consulta el itinerario y registra cada recogida y entrega.</Text></View>
            {lastSync && <Text style={styles.syncCaption}>Última actualización · {shortDate(lastSync)}</Text>}
            {!routes.length ? (
              <View style={styles.emptyCard}><Text style={styles.emptyIcon}>⌁</Text><Text style={styles.sectionTitle}>Aún no tienes rutas asignadas</Text><Text style={styles.muted}>Cuando logística te asigne una ruta, aparecerá aquí. Puedes volver a sincronizar para actualizar.</Text><Button label="Actualizar rutas" onPress={() => void loadRoutes(user, token).catch((error) => Alert.alert('No se pudo actualizar', messageOf(error)))} disabled={!online || busy} secondary /></View>
            ) : routes.map((route) => {
              const active = route.status === 'planned' || route.status === 'in_transit';
              return (
                <Pressable key={route.id} onPress={() => setSelectedRouteId(route.id)} style={({ pressed }) => [styles.routeCard, pressed && styles.buttonPressed]}>
                  <View style={styles.routeCardTop}><Text style={styles.routeCardTitle}>{route.zone?.name ?? route.zone?.code ?? 'Ruta de entregas'}</Text><Badge label={routeLabel(route.status)} tone={route.status === 'completed' ? 'blue' : active ? 'green' : 'amber'} /></View>
                  <Text style={styles.routeCardDate}>{shortDate(route.scheduledDate)}</Text>
                  <View style={styles.routeCardFooter}><Text style={styles.routeMetric}>{route.stops?.length ?? 0} paradas</Text><Text style={styles.routeMetric}>{route.deliveries?.length ?? 0} entregas</Text>{route.vehicle?.plate && <Text style={styles.routeMetric}>Vehículo {route.vehicle.plate}</Text>}<Text style={styles.openLink}>Abrir ›</Text></View>
                </Pressable>
              );
            })}
            {!online && <Text style={styles.helper}>Mostrando la última ruta guardada. Los estados visibles se actualizan cuando el servidor confirma la sincronización.</Text>}
          </>
        )}
      </ScrollView>
      <View style={styles.bottomBar}><Text style={styles.bottomName}>{user.email}</Text><Text style={styles.bottomMeta}>{queue.length ? `${queue.length} acción(es) por sincronizar` : 'Sesión protegida'}</Text></View>
    </SafeAreaView>
  );
}

function DeliverySummary({ delivery }: { delivery: Delivery }) {
  const kg = (delivery.lots ?? []).reduce((sum, lot) => sum + quantity(lot.quantityKg), 0);
  return (
    <View style={styles.deliveryInfo}>
      <Text style={styles.deliveryTitle}>Entrega · {kg.toFixed(3)} kg</Text>
      <Text style={styles.deliveryAddress}>{delivery.deliveryAddress}</Text>
      <Text style={styles.deliveryMeta}>Ventana {shortDate(delivery.windowStart)} – {shortDate(delivery.windowEnd)}</Text>
      {delivery.requiresColdChain && <Badge label="Cadena de frío" tone="blue" />}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 }, safe: { flex: 1, backgroundColor: COLORS.background }, loading: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12, backgroundColor: COLORS.background },
  loginWrap: { flexGrow: 1, justifyContent: 'center', padding: 24, maxWidth: 560, width: '100%', alignSelf: 'center' },
  brandMark: { width: 48, height: 48, borderRadius: 16, backgroundColor: COLORS.green, alignItems: 'center', justifyContent: 'center', marginBottom: 26 }, brandMarkText: { color: '#fff', fontSize: 25, fontWeight: '900' },
  eyebrow: { color: COLORS.green, letterSpacing: 1.5, fontWeight: '800', fontSize: 11 }, heroTitle: { color: COLORS.ink, fontWeight: '800', fontSize: 40, lineHeight: 44, marginTop: 12 }, heroBody: { color: COLORS.muted, fontSize: 16, lineHeight: 24, marginTop: 14, marginBottom: 26 },
  card: { backgroundColor: COLORS.surface, borderColor: COLORS.line, borderWidth: 1, borderRadius: 22, padding: 22, gap: 10, shadowColor: '#18291f', shadowOpacity: 0.06, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 2 }, sectionTitle: { color: COLORS.ink, fontSize: 18, fontWeight: '800', marginBottom: 4 }, label: { fontSize: 13, color: COLORS.ink, fontWeight: '700', marginTop: 6 }, input: { minHeight: 48, borderRadius: 12, borderColor: COLORS.line, borderWidth: 1, backgroundColor: '#fbfcf9', paddingHorizontal: 13, color: COLORS.ink, fontSize: 15 }, helper: { fontSize: 12, color: COLORS.muted, lineHeight: 18, marginTop: 8 },
  button: { backgroundColor: COLORS.green, minHeight: 48, borderRadius: 13, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, marginTop: 8 }, buttonText: { color: '#fff', fontSize: 15, fontWeight: '800' }, buttonSecondary: { backgroundColor: COLORS.greenLight, borderWidth: 1, borderColor: '#c7e0d0' }, buttonSecondaryText: { color: COLORS.green }, buttonDisabled: { opacity: 0.48 }, buttonPressed: { opacity: 0.82, transform: [{ scale: 0.995 }] }, networkLine: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 20 }, networkDot: { width: 8, height: 8, borderRadius: 4 }, dotOnline: { backgroundColor: '#2d9a64' }, dotOffline: { backgroundColor: '#d68a2c' }, muted: { color: COLORS.muted, fontSize: 14, lineHeight: 21 },
  topBar: { paddingHorizontal: 20, paddingVertical: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.surface }, topTitle: { color: COLORS.ink, fontSize: 21, fontWeight: '800', marginTop: 3 }, avatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: COLORS.greenLight, alignItems: 'center', justifyContent: 'center' }, avatarText: { color: COLORS.green, fontSize: 17, fontWeight: '800' },
  connectivity: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingVertical: 10, borderBottomWidth: 1, borderColor: COLORS.line }, connectivityOnline: { backgroundColor: '#f4faf5' }, connectivityOffline: { backgroundColor: COLORS.amberLight }, connectivityText: { color: COLORS.ink, fontSize: 12, fontWeight: '700' }, syncLink: { color: COLORS.green, fontSize: 13, fontWeight: '800', padding: 4 }, content: { padding: 18, gap: 13, maxWidth: 760, width: '100%', alignSelf: 'center', paddingBottom: 26 }, intro: { marginVertical: 8, gap: 5 }, pageTitle: { color: COLORS.ink, fontSize: 30, fontWeight: '800', marginTop: 2 }, syncCaption: { color: COLORS.muted, fontSize: 12, marginBottom: 2 },
  routeCard: { backgroundColor: COLORS.surface, borderRadius: 18, borderWidth: 1, borderColor: COLORS.line, padding: 17, shadowColor: '#18291f', shadowOpacity: 0.04, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 1 }, routeCardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }, routeCardTitle: { color: COLORS.ink, fontSize: 17, fontWeight: '800', flexShrink: 1 }, routeCardDate: { color: COLORS.muted, marginTop: 9, fontSize: 13 }, routeCardFooter: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap', borderTopWidth: 1, borderColor: COLORS.line, paddingTop: 12, marginTop: 13 }, routeMetric: { color: COLORS.muted, fontSize: 12 }, openLink: { color: COLORS.green, fontWeight: '800', marginLeft: 'auto' },
  badge: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999 }, badgeText: { fontSize: 11, fontWeight: '800' }, badgeGreen: { backgroundColor: COLORS.greenLight }, badgeGreenText: { color: COLORS.green }, badgeAmber: { backgroundColor: COLORS.amberLight }, badgeAmberText: { color: COLORS.amber }, badgeRed: { backgroundColor: COLORS.redLight }, badgeRedText: { color: COLORS.red }, badgeBlue: { backgroundColor: '#e9f2f5' }, badgeBlueText: { color: COLORS.blue },
  emptyCard: { backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.line, borderRadius: 20, padding: 24, alignItems: 'flex-start', gap: 12 }, emptyIcon: { color: COLORS.green, fontSize: 32, fontWeight: '800' },
  queueCard: { backgroundColor: COLORS.amberLight, borderColor: '#f0dcba', borderWidth: 1, padding: 14, borderRadius: 16, gap: 7 }, queueHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, queueTitle: { color: COLORS.ink, fontSize: 15, fontWeight: '800' }, queueBody: { color: '#715b3d', fontSize: 12, lineHeight: 17 }, blockedRow: { borderTopWidth: 1, borderColor: '#eed7ad', paddingTop: 8, flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'space-between' }, blockedText: { color: COLORS.red, fontSize: 12, flex: 1 },
  backLink: { paddingVertical: 6 }, backText: { color: COLORS.green, fontWeight: '800', fontSize: 14 }, routeHero: { borderRadius: 20, backgroundColor: '#173c2d', padding: 18, gap: 10 }, routeHeroTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }, routeZone: { color: '#c5d8ca', fontSize: 12, flexShrink: 1, textAlign: 'right' }, routeHeroTitle: { color: '#fff', fontSize: 22, fontWeight: '800' }, routeHeroMeta: { color: '#d0dfd4', fontSize: 13 }, listHeading: { color: COLORS.ink, fontSize: 18, fontWeight: '800', marginTop: 7 },
  stopCard: { backgroundColor: COLORS.surface, borderRadius: 17, borderColor: COLORS.line, borderWidth: 1, padding: 14, gap: 10 }, stopTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 11 }, sequence: { width: 34, height: 34, borderRadius: 12, backgroundColor: COLORS.greenLight, alignItems: 'center', justifyContent: 'center' }, sequenceText: { color: COLORS.green, fontSize: 13, fontWeight: '900' }, stopMain: { flex: 1, gap: 3 }, stopType: { color: COLORS.ink, fontSize: 14, fontWeight: '800' }, stopAddress: { color: COLORS.muted, fontSize: 13, lineHeight: 18 }, stopMeta: { color: '#89948e', fontSize: 11, marginTop: 3 },
  deliveryInfo: { marginLeft: 45, padding: 12, borderRadius: 13, backgroundColor: '#f7f9f5', gap: 5 }, deliveryTitle: { color: COLORS.ink, fontSize: 13, fontWeight: '800' }, deliveryAddress: { color: COLORS.muted, fontSize: 12, lineHeight: 18 }, deliveryMeta: { color: '#89948e', fontSize: 11 }, closePanel: { marginLeft: 45, borderTopWidth: 1, borderColor: COLORS.line, paddingTop: 8, gap: 8 }, quantityRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }, lotLabel: { color: COLORS.muted, fontSize: 12, flex: 1 }, quantityInput: { width: 115, minHeight: 40, textAlign: 'right' }, temperatureRow: { marginLeft: 45, flexDirection: 'row', gap: 8 }, tempInput: { flex: 1, minHeight: 42 },
  bottomBar: { paddingHorizontal: 20, paddingVertical: 10, borderTopWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.surface }, bottomName: { color: COLORS.ink, fontSize: 12, fontWeight: '700' }, bottomMeta: { color: COLORS.muted, fontSize: 11, marginTop: 2 },
});

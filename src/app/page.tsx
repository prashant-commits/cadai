'use client';

import React, { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { LandingPage } from '@/components/landing/landing-page';
import { setNavigator } from '@/store/projects-slice';

export default function Page() {
  const router = useRouter();

  useEffect(() => {
    setNavigator(router.push);
  }, [router]);

  return <LandingPage />;
}
